/**
 * Kidmagic 工作台 HTTP server（P1，node:http 裸实现，无框架）。
 *
 * 路由（JSON；对话暂为非流式，SSE 后置）：
 *   GET  /health                       健康检查
 *   GET  /books                        我的故事（书列表）
 *   GET  /books/:id                    书详情（章节列表）
 *   POST /books                        {title}  新开始：建书 + 建会话 → {bookId, sessionId}
 *   POST /books/:id/continue           续写最新章之后 → {bookId, sessionId, chapterNo}
 *   POST /sessions/:id/messages        {message} 孩子说话 → {reply, stage, gapRoundCount, feedback}
 *
 * 活跃会话保存在内存 Map；会话产物落 PostgreSQL（kidmagic 库，见 DATABASE_URL）。
 * 无账号体系（P2）；素材上传/视觉理解/图生图已接入。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { qwenTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn";
import { openPgDatabase, type Db } from "./storage/db-pg.ts";
import { PG_SCHEMA_SQL } from "./storage/schema-pg.ts";
import {
	createStoryAgent,
	repo,
	createQwenDedicatedProvider,
	QWEN_DEDICATED_PROVIDER_ID,
	type StoryAgentHandle,
} from "./index.ts";
import {
	createSession,
	createBook,
	getBook,
	getLatestChapter,
	getChapter,
	updateChapterTitle,
	updateChapterCover,
	deleteChapter,
	nextIngestBatchNo,
	insertIngestItem,
	confirmIngestBatch,
	discardIngestBatch,
	listBooksWithMeta,
	listChaptersByBook,
	listChapterPagesWithImages,
	listBookMaterials,
	setBookTitle,
	setBookOwner,
	deleteBook,
	createUser,
	getUserByPhone,
	getUserById,
	createChild,
	listChildrenByUser,
	getChildById,
	adminOverview,
	listAdminUsers,
	listAdminChildren,
	listAdminBooks,
	deleteUserCascade,
	createInviteBatch,
	listInviteBatches,
	listInviteCodes,
	getInviteCode,
	updateInviteCode,
	deleteInviteCode,
	deleteInviteBatch,
} from "./storage/repo.ts";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth.ts";
import { tencentAsrSentence } from "./voice/tencent-asr.ts";
import { volcTts } from "./voice/volc-tts.ts";
import type { Persona } from "./agent/stages.ts";
import { analyzeIngestBatch } from "./vision/ingest-cluster.ts";
import { injectAssetContext } from "./agent/asset-context.ts";
import { createImageQueue, createImageWorker, redisConnection } from "./jobs/queue.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://postgres:123456@localhost:5432/kidmagic";
const UPLOAD_DIR = process.env.KIDMAGIC_UPLOADS ?? join(process.cwd(), "uploads");

// demo 防御：未捕获异常/Rejection 只记日志，不退出进程（保工作台存活，便于定位而非整体崩）
process.on("unhandledRejection", (reason) => {
	console.error("[kidmagic][未处理Rejection]", reason);
});
process.on("uncaughtException", (err) => {
	console.error("[kidmagic][未捕获异常]", err);
});
const PUBLIC_DIR = join(process.cwd(), "public");
const PERSONA: Persona = process.env.KIDMAGIC_PERSONA === "B" ? "B" : "A";

// P0-4 语音：腾讯 ASR / 火山 TTS（key 见旧版 .env；未配置时语音接口返回 501）
const ASR_CFG =
	process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY
		? {
				secretId: process.env.TENCENT_SECRET_ID,
				secretKey: process.env.TENCENT_SECRET_KEY,
				region: process.env.TENCENT_ASR_REGION ?? "ap-beijing",
				engine: process.env.TENCENT_ASR_ENGINE ?? "16k_zh",
			}
		: null;
const TTS_CFG =
	process.env.TTS_URL && process.env.TTS_APP_ID && process.env.TTS_ACCESS_KEY
		? {
				url: process.env.TTS_URL,
				appId: process.env.TTS_APP_ID,
				accessKey: process.env.TTS_ACCESS_KEY,
				resourceId: process.env.TTS_RESOURCE_ID ?? "seed-tts-2.0",
				speaker: process.env.TTS_SPEAKER ?? "zh_female_cancan_uranus_bigtts",
				uid: process.env.TTS_UID ?? "local-user",
			}
		: null;

const MIME_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
};

/** 校验 mime 白名单，返回扩展名 */
function extForMime(mimeType: string): string {
	const ext = MIME_EXT[mimeType];
	if (!ext) throw new Error(`不支持的图片类型：${mimeType || "未知"}（仅 png/jpeg/webp/gif）`);
	return ext;
}

/** 校验 base64 + mime 白名单，返回 buffer（两阶段：先全量校验，通过后再统一写盘） */
function decodeBase64Image(base64: string, mimeType: string): { mimeType: string; buf: Buffer } {
	const b64 = base64.replace(/^data:[^;]+;base64,/, "");
	const buf = Buffer.from(b64, "base64");
	if (buf.length === 0) throw new Error("图片 base64 为空");
	if (buf.length > 10 * 1024 * 1024) throw new Error("单张图片超过 10MB 上限");
	extForMime(mimeType); // 白名单校验
	return { mimeType, buf };
}

/** 写一张图到 uploads 目录，返回相对 uri */
function writeImage(mimeType: string, buf: Buffer): string {
	mkdirSync(UPLOAD_DIR, { recursive: true });
	const file = `${uuidv7()}${extForMime(mimeType)}`;
	writeFileSync(join(UPLOAD_DIR, file), buf);
	return `uploads/${file}`;
}

/** 装配模型（与 demo 一致的 provider 选择，server 内联避免动 demo） */
function resolveModel(models: ReturnType<typeof createModels>): { providerId: string; modelId: string } {
	const forceOpenRouter = process.env.KIDMAGIC_PROVIDER === "openrouter";
	const dedicatedBaseUrl = process.env.QWEN_BASE_URL;
	const dedicatedKey =
		process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
	const qwenPlanKey = process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
	const openRouterKey = process.env.OPENROUTER_API_KEY;

	if (!forceOpenRouter && dedicatedBaseUrl && dedicatedKey) {
		const modelId = process.env.QWEN_MODEL ?? process.env.KIDMAGIC_MODEL ?? "qwen3.8-max";
		models.setProvider(createQwenDedicatedProvider({ baseUrl: dedicatedBaseUrl, modelId }));
		return { providerId: QWEN_DEDICATED_PROVIDER_ID, modelId };
	}
	if (!forceOpenRouter && qwenPlanKey) {
		models.setProvider(qwenTokenPlanCnProvider());
		return { providerId: "qwen-token-plan-cn", modelId: process.env.QWEN_MODEL ?? process.env.KIDMAGIC_MODEL ?? "qwen3.8-flash" };
	}
	if (openRouterKey) {
		models.setProvider(openrouterProvider());
		return { providerId: "openrouter", modelId: process.env.OPENROUTER_MODEL ?? process.env.KIDMAGIC_MODEL ?? "google/gemini-2.5-flash" };
	}
	throw new Error(
		"未找到可用模型配置：请设 QWEN_BASE_URL+QWEN_API_KEY 或 QWEN_TOKEN_PLAN_CN_API_KEY 或 OPENROUTER_API_KEY",
	);
}

/** 提取 assistant 消息纯文本 */
function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((b): b is Extract<(typeof message.content)[number], { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
}

/** 路由工具：解析 /books/:id 等路径参数 */
function matchPath(pathname: string, pattern: RegExp): RegExpMatchArray | null {
	return pathname.match(pattern);
}

const db: Db = openPgDatabase(DATABASE_URL);
// 启动时幂等建表（schema-pg.ts：CREATE TABLE IF NOT EXISTS + ALTER ... ADD COLUMN IF NOT EXISTS）。
// PG 上之前只建过 P0-1 的 11 张表，P0-3/P0-6 新增的 users/children/invite_* 与 books 归属列
// 若不在此补，listBooksWithMeta 的 LEFT JOIN children 会报 relation "children" does not exist → /books 500。
// 建表失败不阻断启动：DB 不可用时错误会在请求时暴露，避免 server 一启动即崩。
try {
	await db.query(PG_SCHEMA_SQL);
	console.log("[kidmagic][DB] 已幂等建表（schema-pg.ts）");
} catch (e) {
	console.error(`[kidmagic][DB] 建表失败（后续请求可能报错）：${e instanceof Error ? e.message : String(e)}`);
}
const models = createModels();
const { providerId, modelId } = resolveModel(models);
const model = models.getModel(providerId, modelId);
if (!model) {
	console.error(`模型 ${providerId}/${modelId} 未在 catalog 中找到`);
	process.exit(1);
}
/** 活跃会话（内存态：StoryRuntime 在进程内）；会话产物落库 */
const agents = new Map<string, StoryAgentHandle>();

/**
 * BullMQ 图生图队列（P0-2）：Queue/Worker 为懒连接。
 * 队列不可用 / Redis 挂掉时不阻塞 server——`start_book_generation` 会在
 * `queue.add` 失败时自动降级为同步图生图，绘本始终能出片。
 */
const IMAGE_QUEUE = (() => {
	try {
		const conn = redisConnection();
		const queue = createImageQueue(conn);
		const worker = createImageWorker(db, conn);
		worker.on("error", (e) =>
			console.error(`[kidmagic][队列] worker 错误：${e instanceof Error ? e.message : String(e)}`),
		);
		console.log(
			`[kidmagic][队列] BullMQ 图生图队列就绪（${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? 6379}）`,
		);
		return queue;
	} catch (e) {
		console.error(
			`[kidmagic][队列] Redis 不可用，图生图降级为同步（server 正常运行）：${e instanceof Error ? e.message : String(e)}`,
		);
		return null;
	}
})();

// P0-5 生产加固：CORS 来源可配置（默认放开，部署时设 KIDMAGIC_CORS_ORIGIN 收紧）；统一安全响应头
const CORS_ORIGIN = process.env.KIDMAGIC_CORS_ORIGIN ?? "*";
function securityHeaders(): Record<string, string> {
	return {
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"X-Frame-Options": "SAMEORIGIN",
	};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Access-Control-Allow-Origin": CORS_ORIGIN,
		"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
		...securityHeaders(),
	});
	res.end(payload);
}

/** 读取 JSON body */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			try {
				resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
			} catch (e) {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": CORS_ORIGIN,
			"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
			...securityHeaders(),
		});
		res.end();
		return;
	}
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const pathname = url.pathname;

	// P0-3 鉴权：解析 Bearer JWT → userId；游客（无 token / 无效）为 null，保留免登录体验
	const authHeader = req.headers.authorization ?? "";
	const authUser = authHeader.startsWith("Bearer ") ? (verifyToken(authHeader.slice(7).trim())?.sub ?? null) : null;

	try {
		// GET /health
		if (req.method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, providerId, modelId });

		// ── P0-3 账号：家长（手机号+密码）+ 孩子档案 ──
		// POST /api/auth/register
		if (req.method === "POST" && pathname === "/api/auth/register") {
			const body = await readBody(req);
			const phone = String(body.phone ?? "").trim();
			const password = String(body.password ?? "");
			if (!/^1\d{10}$/.test(phone)) return sendJson(res, 400, { error: "手机号格式不正确（11 位）" });
			if (password.length < 6) return sendJson(res, 400, { error: "密码至少 6 位" });
			if (await getUserByPhone(db, phone)) return sendJson(res, 409, { error: "该手机号已注册" });
			const userId = await createUser(db, {
				phone,
				passwordHash: hashPassword(password),
				nickname: String(body.nickname ?? "").trim(),
			});
			const token = signToken(userId, 60 * 60 * 24 * 30); // 30 天
			return sendJson(res, 201, { token, user: { id: userId, phone, nickname: String(body.nickname ?? "").trim() } });
		}
		// POST /api/auth/login
		if (req.method === "POST" && pathname === "/api/auth/login") {
			const body = await readBody(req);
			const phone = String(body.phone ?? "").trim();
			const password = String(body.password ?? "");
			const user = await getUserByPhone(db, phone);
			if (!user || !verifyPassword(password, user.password_hash)) return sendJson(res, 401, { error: "手机号或密码错误" });
			const token = signToken(user.id, 60 * 60 * 24 * 30);
			return sendJson(res, 200, { token, user: { id: user.id, phone: user.phone, nickname: user.nickname } });
		}

		// ── P0-6 管理员后台 ──
		// 启用条件：配置 KIDMAGIC_ADMIN_PASSWORD；admin token 复用 JWT 签名，sub 固定为 "admin"
		const adminPassword = process.env.KIDMAGIC_ADMIN_PASSWORD ?? "";
		const isAdmin = (h: string): boolean => {
			if (!h.startsWith("Bearer ")) return false;
			const p = verifyToken(h.slice(7).trim());
			return !!p && p.sub === "admin";
		};
		if (pathname.startsWith("/api/admin")) {
			if (!adminPassword) return sendJson(res, 501, { error: "管理员后台未配置（需设置 KIDMAGIC_ADMIN_PASSWORD）" });
			if (req.method === "POST" && pathname === "/api/admin/login") {
				const body = await readBody(req);
				const given = String(body.password ?? "");
				const ok =
					Buffer.byteLength(given) === Buffer.byteLength(adminPassword) &&
					timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(adminPassword, "utf8"));
				if (!ok) return sendJson(res, 401, { error: "管理员密码错误" });
				return sendJson(res, 200, { token: signToken("admin", 8 * 3600) });
			}
			if (!isAdmin(req.headers.authorization ?? "")) return sendJson(res, 401, { error: "请先登录管理员后台" });

			// 概览
			if (req.method === "GET" && pathname === "/api/admin/overview")
				return sendJson(res, 200, { overview: await adminOverview(db) });
			// 用户 / 用户详情孩子
			if (req.method === "GET" && pathname === "/api/admin/users")
				return sendJson(res, 200, { users: await listAdminUsers(db) });
			if (req.method === "GET" && /^\/api\/admin\/users\/[^/]+\/children$/.test(pathname)) {
				const uid = decodeURIComponent(pathname.split("/")[3]);
				return sendJson(res, 200, { children: await listAdminChildren(db, uid) });
			}
			// 删除用户（级联删孩子与作品）
			if (req.method === "DELETE" && /^\/api\/admin\/users\/[^/]+$/.test(pathname)) {
				const uid = decodeURIComponent(pathname.split("/")[3]);
				return sendJson(res, 200, await deleteUserCascade(db, uid));
			}
			// 书列表 / 删除
			if (req.method === "GET" && pathname === "/api/admin/books") {
				const userId = url.searchParams.get("userId") ?? undefined;
				const childId = url.searchParams.get("childId") ?? undefined;
				return sendJson(res, 200, { books: await listAdminBooks(db, { userId, childId }) });
			}
			if (req.method === "DELETE" && /^\/api\/admin\/books\/[^/]+$/.test(pathname)) {
				await deleteBook(db, decodeURIComponent(pathname.split("/")[3]));
				return sendJson(res, 200, { ok: true });
			}
			// 邀请码批次：列表 / 创建 / 删除 / 批次内码 / CSV 导出
			if (req.method === "GET" && pathname === "/api/admin/invite-batches")
				return sendJson(res, 200, { batches: await listInviteBatches(db) });
			if (req.method === "POST" && pathname === "/api/admin/invite-batches") {
				const body = await readBody(req);
				try {
					const batch = await createInviteBatch(db, {
						name: String(body.name ?? ""),
						count: Number(body.count ?? 0),
						baseUrl: String(body.baseUrl ?? ""),
						note: String(body.note ?? ""),
					});
					return sendJson(res, 201, { batch });
				} catch (e) {
					return sendJson(res, 400, { error: e instanceof Error ? e.message : "创建批次失败" });
				}
			}
			if (req.method === "GET" && /^\/api\/admin\/invite-batches\/[^/]+\/codes$/.test(pathname)) {
				const batchId = decodeURIComponent(pathname.split("/")[3]);
				return sendJson(res, 200, { codes: await listInviteCodes(db, batchId) });
			}
			if (req.method === "GET" && /^\/api\/admin\/invite-batches\/[^/]+\/csv$/.test(pathname)) {
				const batchId = decodeURIComponent(pathname.split("/")[3]);
				const codes = await listInviteCodes(db, batchId);
				if (!codes.length) return sendJson(res, 404, { error: "批次不存在" });
				const csv =
					"code,status,user_name,book_id,activated_at\n" +
					codes.map((c) => `${c.code},${c.status},${c.user_name},${c.book_id ?? ""},${c.activated_at ?? ""}`).join("\n");
				res.writeHead(200, {
					"Content-Type": "text/csv; charset=utf-8",
					"Content-Disposition": `attachment; filename="${batchId}_codes.csv"`,
					...securityHeaders(),
				});
				res.end(Buffer.from("\uFEFF" + csv, "utf8"));
				return;
			}
			if (req.method === "DELETE" && /^\/api\/admin\/invite-batches\/[^/]+$/.test(pathname)) {
				await deleteInviteBatch(db, decodeURIComponent(pathname.split("/")[3]));
				return sendJson(res, 200, { ok: true });
			}
			// 邀请码：列表 / 改状态与用户名 / 删除
			if (req.method === "GET" && pathname === "/api/admin/invite-codes") {
				const batchId = url.searchParams.get("batchId") ?? undefined;
				return sendJson(res, 200, { codes: await listInviteCodes(db, batchId) });
			}
			if (req.method === "PATCH" && /^\/api\/admin\/invite-codes\/[^/]+$/.test(pathname)) {
				const body = await readBody(req);
				try {
					const code = await updateInviteCode(db, decodeURIComponent(pathname.split("/")[3]), {
						userName: body.userName === undefined ? undefined : String(body.userName),
						status: body.status === undefined ? undefined : String(body.status),
					});
					return sendJson(res, 200, { code });
				} catch (e) {
					return sendJson(res, 400, { error: e instanceof Error ? e.message : "更新失败" });
				}
			}
			if (req.method === "DELETE" && /^\/api\/admin\/invite-codes\/[^/]+$/.test(pathname)) {
				await deleteInviteCode(db, decodeURIComponent(pathname.split("/")[3]));
				return sendJson(res, 200, { ok: true });
			}
			return sendJson(res, 404, { error: "管理员接口不存在" });
		}

		// GET /api/me（当前登录态 + 孩子档案列表）
		if (req.method === "GET" && pathname === "/api/me") {
			if (!authUser) return sendJson(res, 401, { error: "未登录" });
			const user = await getUserById(db, authUser);
			if (!user) return sendJson(res, 401, { error: "账号不存在" });
			const children = await listChildrenByUser(db, authUser);
			return sendJson(res, 200, {
				user: { id: user.id, phone: user.phone, nickname: user.nickname },
				children,
			});
		}
		// POST /api/children（新增孩子档案）
		if (req.method === "POST" && pathname === "/api/children") {
			if (!authUser) return sendJson(res, 401, { error: "未登录" });
			const body = await readBody(req);
			const name = String(body.name ?? "").trim();
			if (!name) return sendJson(res, 400, { error: "孩子名字不能为空" });
			const age = body.age == null ? null : Number(body.age);
			const childId = await createChild(db, {
				userId: authUser,
				name,
				age: Number.isFinite(age) ? age : null,
				avatar: body.avatar ? String(body.avatar) : null,
			});
			return sendJson(res, 201, { child: { id: childId, name, age } });
		}

		// ── P0-4 语音：ASR（孩子开口讲） / TTS（琪琪老师开口回应） ──
		// POST /api/voice/recognize：音频 base64 + mime → 识别文本
		if (req.method === "POST" && pathname === "/api/voice/recognize") {
			if (!ASR_CFG) { console.log("[语音] ASR 未配置（需 TENCENT_SECRET_ID/KEY）"); return sendJson(res, 501, { error: "ASR 未配置（需 TENCENT_SECRET_ID/KEY）" }); }
			const body = await readBody(req);
			const audio = typeof body.audio === "string" ? body.audio : "";
			if (!audio) return sendJson(res, 400, { error: "缺少音频" });
			let bytes: Buffer;
			try { bytes = Buffer.from(audio, "base64"); } catch { return sendJson(res, 400, { error: "音频 base64 无效" }); }
			if (!bytes.length) return sendJson(res, 400, { error: "音频为空" });
			const mime = typeof body.mime === "string" ? body.mime : "audio/webm";
			try {
				const text = await tencentAsrSentence(ASR_CFG, { audioBytes: bytes, mime });
				console.log(`[语音] ASR 成功 ${bytes.length}B/${mime} →「${text.slice(0, 24)}${text.length > 24 ? "…" : ""}」`);
				return sendJson(res, 200, { text });
			} catch (e) {
				console.log(`[语音] ASR 失败：${(e as Error).message}`);
				return sendJson(res, 502, { error: `识别失败：${(e as Error).message}` });
			}
		}
		// POST /api/voice/tts：文本 → mp3 音频流
		if (req.method === "POST" && pathname === "/api/voice/tts") {
			if (!TTS_CFG) { console.log("[语音] TTS 未配置（需 TTS_URL/APP_ID/ACCESS_KEY）"); return sendJson(res, 501, { error: "TTS 未配置（需 TTS_URL/APP_ID/ACCESS_KEY）" }); }
			const body = await readBody(req);
			const text = typeof body.text === "string" && body.text.trim() ? body.text.trim() : "";
			if (!text) return sendJson(res, 400, { error: "缺少文本" });
			if (text.length > 500) return sendJson(res, 400, { error: "文本过长（≤500 字）" });
			try {
				const audio = await volcTts(TTS_CFG, text);
				console.log(`[语音] TTS 成功 ${audio.length}B →「${text.slice(0, 24)}${text.length > 24 ? "…" : ""}」`);
				res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, ...securityHeaders() });
				res.end(audio);
				return;
			} catch (e) {
				console.log(`[语音] TTS 失败：${(e as Error).message}`);
				return sendJson(res, 502, { error: `合成失败：${(e as Error).message}` });
			}
		}

		// GET /（H5 工作台静态入口）
		if (req.method === "GET" && pathname === "/") {
			const htmlPath = join(PUBLIC_DIR, "index.html");
			const html = existsSync(htmlPath)
				? readFileSync(htmlPath, "utf8")
				: "<!doctype html><html><head><meta charset='utf-8'><title>Kidmagic</title></head><body><h1>Kidmagic 工作台</h1><p>index.html 尚未创建（H5-A 占位）。</p></body></html>";
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...securityHeaders() });
			res.end(html);
			return;
		}

		// GET /admin（P0-6 管理员后台页面）
		if (req.method === "GET" && pathname === "/admin") {
			const adminPath = join(PUBLIC_DIR, "admin.html");
			const html = existsSync(adminPath)
				? readFileSync(adminPath, "utf8")
				: "<!doctype html><html><head><meta charset='utf-8'><title>Kidmagic Admin</title></head><body><h1>管理员后台</h1><p>admin.html 尚未创建。</p></body></html>";
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...securityHeaders() });
			res.end(html);
			return;
		}

		// GET PWA 静态资产（P0-6 第二优先级：manifest / icon，白名单防穿越）
		if (req.method === "GET" && (pathname === "/manifest.webmanifest" || pathname === "/icon.svg")) {
			const file = pathname === "/manifest.webmanifest" ? "manifest.webmanifest" : "icon.svg";
			const p = join(PUBLIC_DIR, file);
			if (existsSync(p)) {
				res.writeHead(200, {
					"Content-Type":
						pathname === "/manifest.webmanifest"
							? "application/manifest+json; charset=utf-8"
							: "image/svg+xml; charset=utf-8",
					...securityHeaders(),
				});
				res.end(readFileSync(p));
				return;
			}
		}

		// GET /books（P0-3 按归属过滤：登录→该家长/孩子的书；游客→未绑定 owner 的书）
		if (req.method === "GET" && pathname === "/books") {
			if (authUser) {
				const childId = url.searchParams.get("childId");
				const books = childId
					? await listBooksWithMeta(db, { userId: authUser, childId })
					: await listBooksWithMeta(db, { userId: authUser });
				return sendJson(res, 200, { books });
			}
			return sendJson(res, 200, { books: await listBooksWithMeta(db, { guest: true }) });
		}

		// GET /books/:id（详情：章节 + 前情提要）
		const detail = matchPath(pathname, /^\/books\/([^/]+)$/);
		if (req.method === "GET" && detail) {
			const book = await getBook(db, detail[1]);
			if (!book) return sendJson(res, 404, { error: "书不存在" });
			return sendJson(res, 200, { book, chapters: await listChaptersByBook(db, book.id) });
		}

		// POST /books（新开始：建书 + 建会话）
		if (req.method === "POST" && pathname === "/books") {
			const body = await readBody(req);
			const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "我的新故事";
			// P0-3：登录且选了孩子档案时，把作品挂到该孩子（游客不挂 owner，保留免登录体验）
			let childId: string | null = null;
			if (authUser && body.childId) {
				const child = await getChildById(db, String(body.childId));
				if (!child || child.user_id !== authUser) return sendJson(res, 400, { error: "孩子档案不存在或不属于当前账号" });
				childId = child.id;
			}
			const sessionId = await createSession(db, PERSONA);
			const bookId = await createBook(db, { sessionId, title, userId: authUser, childId });
			const handle = await createStoryAgent({
				db,
				model,
				persona: PERSONA,
				sessionId,
				streamFn: models.streamSimple.bind(models),
				// 关键：把本书 bookId 挂进 runtime，start_book_generation 才把第一章写进本书，
				// 否则 runtime.bookId 为空会走 createBook 新建第二本（产生"空书 + 内容在错书"的双书 bug）
				imageQueue: IMAGE_QUEUE,
				continuation: { bookId, recapSummary: "", chapterNo: 1 },
			});
			agents.set(sessionId, handle);
			return sendJson(res, 201, { bookId, sessionId, title });
		}

		// PATCH /books/:id（重命名书名）
		const patch = matchPath(pathname, /^\/books\/([^/]+)$/);
		if (req.method === "PATCH" && patch) {
			const book = await getBook(db, patch[1]);
			if (!book) return sendJson(res, 404, { error: "书不存在" });
			const body = await readBody(req);
			const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
			if (!title) return sendJson(res, 400, { error: "标题不能为空" });
			await setBookTitle(db, patch[1], title);
			return sendJson(res, 200, { ok: true });
		}

		// DELETE /books/:id（删除整本书及其全部数据）
		const del = matchPath(pathname, /^\/books\/([^/]+)$/);
		if (req.method === "DELETE" && del) {
			const book = await getBook(db, del[1]);
			if (!book) return sendJson(res, 404, { error: "书不存在" });
			await deleteBook(db, del[1]);
			return sendJson(res, 200, { ok: true });
		}

		// POST /books/:id/continue（有章节：续写最新章之后；无章节：开始本书第一章）
		const cont = matchPath(pathname, /^\/books\/([^/]+)\/continue$/);
		if (req.method === "POST" && cont) {
			const book = await getBook(db, cont[1]);
			if (!book) return sendJson(res, 404, { error: "书不存在" });
			const latest = await getLatestChapter(db, book.id);
			const sessionId = await createSession(db, PERSONA);
			if (!latest?.recap_summary) {
				// 首章：无前情提要，挂到书 + 章节号 1（buildContinuationPrefix 对空 recap 走"开始新故事"分支）
				const handle = await createStoryAgent({
					db,
					model,
					persona: PERSONA,
					sessionId,
					streamFn: models.streamSimple.bind(models),
					imageQueue: IMAGE_QUEUE,
					continuation: { bookId: book.id, recapSummary: "", chapterNo: 1 },
				});
				agents.set(sessionId, handle);
				return sendJson(res, 201, { bookId: book.id, sessionId, chapterNo: 1 });
			}
			const chapterNo = (latest.chapter_no ?? 1) + 1;
			const handle = await createStoryAgent({
				db,
				model,
				persona: PERSONA,
				sessionId,
				streamFn: models.streamSimple.bind(models),
				imageQueue: IMAGE_QUEUE,
				continuation: { bookId: book.id, recapSummary: latest.recap_summary, chapterNo },
			});
			agents.set(sessionId, handle);
			return sendJson(res, 201, { bookId: book.id, sessionId, chapterNo });
		}

		// POST /books/:id/uploads/confirm（确认一批，触发后续视觉理解）
		const conf = matchPath(pathname, /^\/books\/([^/]+)\/uploads\/confirm$/);
		if (req.method === "POST" && conf) {
			const body = await readBody(req);
			const batchNo = Number(body.batchNo);
			if (!Number.isInteger(batchNo) || batchNo < 1) return sendJson(res, 400, { error: "batchNo 非法" });
			await confirmIngestBatch(db, conf[1], batchNo);
			console.log(`[素材] 确认批次 ${batchNo}（书=${conf[1].slice(0, 8)}）`);
			return sendJson(res, 200, { ok: true });
		}

		// POST /books/:id/uploads/discard（丢弃一批）
		const disc = matchPath(pathname, /^\/books\/([^/]+)\/uploads\/discard$/);
		if (req.method === "POST" && disc) {
			const body = await readBody(req);
			const batchNo = Number(body.batchNo);
			if (!Number.isInteger(batchNo) || batchNo < 1) return sendJson(res, 400, { error: "batchNo 非法" });
			await discardIngestBatch(db, disc[1], batchNo);
			return sendJson(res, 200, { ok: true });
		}

		// POST /books/:id/uploads（base64 上传，每批 ≤10 张）
		const up = matchPath(pathname, /^\/books\/([^/]+)\/uploads$/);
		if (req.method === "POST" && up) {
			const book = await getBook(db, up[1]);
			if (!book) return sendJson(res, 404, { error: "书不存在" });
			const body = await readBody(req);
			const images = Array.isArray(body.images) ? (body.images as Record<string, unknown>[]) : [];
			if (images.length === 0) return sendJson(res, 400, { error: "images 不能为空" });
			if (images.length > 10) return sendJson(res, 400, { error: "每批最多上传 10 张" });
			// 素材归属会话：优先用前端传入的当前对话 sessionId（续写后对话在 continue 新会话，book.session_id 是首章旧会话）
			const sess = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : book.session_id;

			// 阶段一：全量解码校验（任一非法 → 整批 400，不落库）
			const decoded: { mimeType: string; buf: Buffer }[] = [];
			try {
				for (const img of images) {
					const mimeType = typeof img.mimeType === "string" ? img.mimeType : "";
					const base64 = typeof img.base64 === "string" ? img.base64 : "";
					decoded.push(decodeBase64Image(base64, mimeType));
				}
			} catch (err) {
				return sendJson(res, 400, { error: err instanceof Error ? err.message : "图片校验失败" });
			}

			// 阶段二：全部通过后统一写盘 + 入库（保证批次原子性）
			const batchNo = await nextIngestBatchNo(db, book.id);
			const items: { id: string; uri: string; mimeType: string }[] = [];
			for (const d of decoded) {
				const uri = writeImage(d.mimeType, d.buf);
				const itemId = await insertIngestItem(db, {
					sessionId: sess,
					bookId: book.id,
					batchNo,
					mimeType: d.mimeType,
					uri,
				});
				items.push({ id: itemId, uri, mimeType: d.mimeType });
			}
			console.log(`[素材] 上传 ${items.length} 张，批次 ${batchNo}（书=${book.id.slice(0, 8)}，会话=${book.session_id.slice(0, 8)}）`);
			return sendJson(res, 201, { batchNo, count: items.length, items });
		}

		// POST /books/:id/uploads/:batch/analyze（前端确认后触发视觉理解聚类）
		const an = matchPath(pathname, /^\/books\/([^/]+)\/uploads\/(\d+)\/analyze$/);
		if (req.method === "POST" && an) {
			const book = await getBook(db, an[1]);
			if (!book) return sendJson(res, 404, { error: "书不存在" });
			const batchNo = Number(an[2]);
			// 用前端传入的当前对话 sessionId（续写后对话在 continue 新会话，book.session_id 是首章旧会话）
			const qs = new URL(req.url ?? "", "http://localhost").searchParams.get("session");
			const sess = (qs && qs.trim()) || book.session_id;
			const result = await analyzeIngestBatch(db, { sessionId: sess, bookId: book.id, batchNo });
			console.log(`[素材] 视觉理解：ok=${result.ok} 认出=${result.labels.join("、") || "无"} 失败=${result.failed}/${result.total} 会话=${sess.slice(0, 8)}`);
			// 素材确认后注入 agent 上下文：让 agent 看得见孩子传的画（视觉理解结果），避免生成脱离素材
			if (result.ok) {
				const handle = agents.get(sess);
				if (!handle) {
					console.log(`[素材注入] 未找到该会话 agent，素材未注入（会话=${sess.slice(0, 8)}）`);
				} else {
					await injectAssetContext(handle.agent, db, sess, book.id);
					console.log(`[素材注入] 已触发注入（会话=${sess.slice(0, 8)}）`);
				}
			}
			return sendJson(res, result.ok ? 200 : 422, result);
		}

		// PATCH/DELETE /books/:bid/chapters/:cid（章节改名 / 删除，P0-6）
		const chMgr = matchPath(pathname, /^\/books\/([^/]+)\/chapters\/([^/]+)$/);
		if (req.method === "PATCH" && chMgr) {
			const chapter = await getChapter(db, chMgr[2]);
			if (!chapter) return sendJson(res, 404, { error: "章节不存在" });
			const body = await readBody(req);
			const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
			if (!title) return sendJson(res, 400, { error: "章节标题不能为空" });
			await updateChapterTitle(db, chMgr[2], title);
			console.log(`[章节] 改名 ${chMgr[2].slice(0, 8)} →「${title}」`);
			return sendJson(res, 200, { ok: true });
		}
		if (req.method === "DELETE" && chMgr) {
			const chapter = await getChapter(db, chMgr[2]);
			if (!chapter) return sendJson(res, 404, { error: "章节不存在" });
			await deleteChapter(db, chMgr[2]);
			console.log(`[章节] 删除 ${chMgr[2].slice(0, 8)}（第${chapter.chapter_no}章）`);
			return sendJson(res, 200, { ok: true });
		}
		// POST /books/:bid/chapters/:cid/cover（章节封面上传：base64 → 写盘 → 存 cover_asset_id）
		const chCover = matchPath(pathname, /^\/books\/([^/]+)\/chapters\/([^/]+)\/cover$/);
		if (req.method === "POST" && chCover) {
			const chapter = await getChapter(db, chCover[2]);
			if (!chapter) return sendJson(res, 404, { error: "章节不存在" });
			const body = await readBody(req);
			const mimeType = typeof body.mimeType === "string" ? body.mimeType : "image/jpeg";
			const base64 = typeof body.base64 === "string" ? body.base64 : "";
			let dec: { mimeType: string; buf: Buffer };
			try { dec = decodeBase64Image(base64, mimeType); }
			catch (err) { return sendJson(res, 400, { error: err instanceof Error ? err.message : "图片校验失败" }); }
			const uri = writeImage(dec.mimeType, dec.buf);
			await updateChapterCover(db, chCover[2], uri);
			console.log(`[章节] 封面上传 ${chCover[2].slice(0, 8)} → ${uri}`);
			return sendJson(res, 201, { cover_asset_id: uri });
		}

		// GET /books/:id/chapters/:cid/pages（绘本页文字+图，工作台展示）
		const cp = matchPath(pathname, /^\/books\/([^/]+)\/chapters\/([^/]+)\/pages$/);
		if (req.method === "GET" && cp) {
			const chapter = await getChapter(db, cp[2]);
			if (!chapter) return sendJson(res, 404, { error: "章节不存在" });
			return sendJson(res, 200, { chapter, pages: await listChapterPagesWithImages(db, chapter.id) });
		}

		// GET /books/:id/latest-chapter/pages（画布轮询：取最新一章页面，生成期间逐页铺到画布背景）
		const lcp = matchPath(pathname, /^\/books\/([^/]+)\/latest-chapter\/pages$/);
		if (req.method === "GET" && lcp) {
			const book = await getBook(db, lcp[1]);
			if (!book) return sendJson(res, 404, { error: "书不存在" });
			const latest = await getLatestChapter(db, book.id);
			if (!latest) return sendJson(res, 200, { chapter: null, pages: [] });
			return sendJson(res, 200, { chapter: latest, pages: await listChapterPagesWithImages(db, latest.id) });
		}

		// GET /uploads/<date>/<file>（取孩子上传原图 / 图生图页图，前端展示用）
		// 页图按天存 uploads/<YYYY-MM-DD>/ 子目录，避免根目录堆积；相对路径须防穿越
		const file = matchPath(pathname, /^\/uploads\/(.+)$/);
		if (req.method === "GET" && file) {
			const rel = decodeURIComponent(file[1]);
			const root = resolve(UPLOAD_DIR);
			const p = resolve(root, rel);
			// 防路径穿越：解析后必须仍在 uploads 根目录内
			if (p !== root && !p.startsWith(root + sep)) return sendJson(res, 404, { error: "非法路径" });
			if (!existsSync(p) || statSync(p).isDirectory()) return sendJson(res, 404, { error: "文件不存在" });
			const ext = basename(p).split(".").pop()?.toLowerCase() ?? "";
			const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
			res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
			res.end(readFileSync(p));
			return;
		}

		// GET /sessions/:id/assets（画布：当前会话已提取的角色/场景资产 + 外观）
		// 数据源=asset_clusters（视觉理解"琪琪老师认出来的"），不再读 story_elements（孩子还没讲时为空）
		const as = matchPath(pathname, /^\/sessions\/([^/]+)\/assets$/);
		if (req.method === "GET" && as) {
			const rows = (await db.query(
				"SELECT id, cluster_type, label, appearance FROM asset_clusters WHERE session_id = $1 ORDER BY cluster_type, created_at",
				[as[1]],
			)) as unknown as { id: string; cluster_type: string; label: string; appearance: string }[];
			const characters: { id: string; label: string; detail: { name: string; appearance: string; personality: string; catchphrase: string } | null }[] = [];
			const settings: { id: string; label: string }[] = [];
			for (const r of rows) {
				if (r.cluster_type === "character") {
					characters.push({
						id: r.id,
						label: r.label,
						detail: r.appearance
							? { name: r.label, appearance: r.appearance, personality: "", catchphrase: "" }
							: null,
					});
				} else if (r.cluster_type === "setting") {
					settings.push({ id: r.id, label: r.appearance ? `${r.label}（${r.appearance}）` : r.label });
				}
			}
			return sendJson(res, 200, { characters, settings });
		}

		// GET /books/:id/assets（回看绘本：整书角色/场景资产 + 外观）
		const ba = matchPath(pathname, /^\/books\/([^/]+)\/assets$/);
		if (req.method === "GET" && ba) {
			const book = await repo.getBook(db, ba[1]);
			if (!book) return sendJson(res, 404, { error: "book not found" });
			const rows = (await db.query(
				"SELECT id, cluster_type, label, appearance FROM asset_clusters WHERE session_id = $1 ORDER BY cluster_type, created_at",
				[book.session_id],
			)) as unknown as { id: string; cluster_type: string; label: string; appearance: string }[];
			const characters: { id: string; label: string; detail: { name: string; appearance: string; personality: string; catchphrase: string } | null }[] = [];
			const settings: { id: string; label: string }[] = [];
			for (const r of rows) {
				if (r.cluster_type === "character") {
					characters.push({
						id: r.id,
						label: r.label,
						detail: r.appearance
							? { name: r.label, appearance: r.appearance, personality: "", catchphrase: "" }
							: null,
					});
				} else if (r.cluster_type === "setting") {
					settings.push({ id: r.id, label: r.appearance ? `${r.label}（${r.appearance}）` : r.label });
				}
			}
			return sendJson(res, 200, { characters, settings });
		}

		// GET /books/:id/materials（素材碎片：已确认上传的原图，供资产弹窗展示）
		const mat = matchPath(pathname, /^\/books\/([^/]+)\/materials$/);
		if (req.method === "GET" && mat) {
			return sendJson(res, 200, { materials: await listBookMaterials(db, mat[1]) });
		}

		// POST /sessions/:id/messages（孩子说话 → agent 回复 + 工具反馈）
		const msg = matchPath(pathname, /^\/sessions\/([^/]+)\/messages$/);
		if (req.method === "POST" && msg) {
			const handle = agents.get(msg[1]);
			if (!handle) return sendJson(res, 404, { error: "会话不存在或已结束" });
			const body = await readBody(req);
			const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "";
			if (!message) return sendJson(res, 400, { error: "message 不能为空" });

			const feedback: { tool: string; args: unknown }[] = [];
			const sub = handle.agent.subscribe((e) => {
				if (e.type === "tool_execution_start") feedback.push({ tool: e.toolName, args: e.args });
			});
			await handle.agent.prompt(message);
			sub();
			const assistants = handle.agent.state.messages.filter((m) => m.role === "assistant") as AssistantMessage[];
			console.log(`[对话] 阶段=${handle.runtime.stage} 缺口轮次=${handle.runtime.gapRoundCount} 反馈工具=[${feedback.map((f) => f.tool).join(",")}] 会话=${msg[1].slice(0, 8)}`);
			return sendJson(res, 200, {
				reply: assistantText(assistants.at(-1)),
				stage: handle.runtime.stage,
				gapRoundCount: handle.runtime.gapRoundCount,
				feedback,
			});
		}

		return sendJson(res, 404, { error: `未找到路由 ${req.method} ${pathname}` });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return sendJson(res, 500, { error: message });
	}
});

server.listen(PORT, () => {
	console.log(`Kidmagic server 已启动：http://localhost:${PORT}　provider=${providerId}/${modelId}　db=${DATABASE_URL}`);
});
