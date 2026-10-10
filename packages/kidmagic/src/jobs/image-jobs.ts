/**
 * 绘本章节配图生成（P0-2 BullMQ 异步化的核心单元）。
 *
 * 从 `start_book_generation` 抽离：同一套图生图逻辑，可被
 * 1) worker 后台队列消费（异步入队路径）；
 * 2) 工具同步降级路径（Redis 不可用 / 无队列）直接内联调用。
 * 避免两处维护两份图生图实现。
 *
 * 安全约定：job data 只携带 bookId/chapterId/sessionId/title/world（id + 文本），
 * 绝不含 apiKey 与图片二进制；参考图（孩子原画 data URI）与图生图配置（含 key）
 * 一律在 worker 内从 env/库 重建，不落 Redis。
 */
import type { Db } from "../storage/db-pg.ts";
import {
	listChapterPagesWithImages,
	markBookDone,
	updateBookPageGeneratedImage,
} from "../storage/repo.ts";
import { buildPageImagePrompt, type WorldCards } from "../agent/image-prompt.ts";
import { validateChapterPage, validateWorldCards } from "../agent/consistency.ts";
import { resolveReferenceImage } from "../agent/reference-asset.ts";
import {
	dashscopeGenerateImage,
	resolveDashScopeImageConfig,
} from "../image/dashscope-image.ts";
import { saveRemoteImage } from "../util/save-image.ts";

/** 章节配图 job 数据（可安全序列化进 Redis：仅 id + 文本，无 key / 无图片二进制） */
export interface ChapterImageJobData {
	bookId: string;
	chapterId: string;
	sessionId: string;
	title: string;
	/** 兼容旧 job（文本 world）；P0-5 起以 worker 内重建的结构化卡片为准 */
	world?: { characters?: string; settings?: string };
}

/**
 * P0-5 一致性：从库重建「角色/场景卡」。
 * 数据源按原创贴近度排序，逐层兜底、按名去重：
 * 1) asset_clusters 半自动确认的角色/场景（孩子素材，最贴近原创）；
 * 2) characters 角色卡（build_character_card 写入、书关联）；
 * 3) story_elements 的孩子讲述角色/场景（content 兜底，无外观描述）。
 */
async function buildWorldCards(db: Db, data: ChapterImageJobData): Promise<WorldCards> {
	const clusters = (await db.query(
		"SELECT cluster_type, label, appearance FROM asset_clusters WHERE session_id = $1 AND cluster_type IN ('character','setting') ORDER BY cluster_type, created_at",
		[data.sessionId],
	)) as unknown as { cluster_type: string; label: string; appearance: string | null }[];

	const chars = data.bookId
		? ((await db.query(
				"SELECT c.name, c.appearance FROM characters c JOIN book_characters bc ON bc.character_id = c.id WHERE bc.book_id = $1",
				[data.bookId],
			)) as unknown as { name: string; appearance: string | null }[])
		: [];

	const els = (await db.query(
		"SELECT element_type, content FROM story_elements WHERE session_id = $1 AND element_type IN ('character','setting') ORDER BY order_idx, created_at",
		[data.sessionId],
	)) as unknown as { element_type: string; content: string }[];

	const characters: WorldCards["characters"] = [];
	const settings: WorldCards["settings"] = [];
	const seenC = new Set<string>();
	const seenS = new Set<string>();
	const pushC = (name: string, appearance?: string | null) => {
		const k = name.trim();
		if (!k || seenC.has(k)) return;
		seenC.add(k);
		characters!.push({ name: k, appearance: appearance?.trim() || undefined });
	};
	const pushS = (name: string, appearance?: string | null) => {
		const k = name.trim();
		if (!k || seenS.has(k)) return;
		seenS.add(k);
		settings!.push({ name: k, appearance: appearance?.trim() || undefined });
	};
	for (const c of clusters) (c.cluster_type === "character" ? pushC : pushS)(c.label, c.appearance);
	for (const c of chars) pushC(c.name, c.appearance);
	for (const e of els) (e.element_type === "character" ? pushC : pushS)(e.content);
	return { characters, settings };
}

/**
 * 为章节每一页生成配图并写回 generated_image_uri（串行 + 退避重试）。
 * 单页失败仅降级为纯文字页（该页无图），不抛错、不阻塞；返回成功配图页数。
 * 不负责 markBookDone：由调用方（worker processor / 工具同步路径）决定何时落 done。
 * 未配置图生图（无 key / 被禁用）时直接返回 0（整章纯文字）。
 */
export async function generateChapterImages(
	db: Db,
	data: ChapterImageJobData,
): Promise<number> {
	const imgCfg = resolveDashScopeImageConfig();
	if (!imgCfg) return 0;

	const pages = await listChapterPagesWithImages(db, data.chapterId);
	if (pages.length === 0) return 0;

	// P0-5 一致性：重建角色/场景卡并校验（不合格记警告，不阻塞——可能还没素材）
	const cards = await buildWorldCards(db, data);
	const cardCheck = validateWorldCards(cards);
	if (!cardCheck.ok) console.warn(`[kidmagic][图生图] 世界卡片校验：${cardCheck.errors.join("；")}`);

	// 主角参考图（孩子原画锚）：worker 内从库重建，不进 job data
	const refImage = await resolveReferenceImage(db, data.sessionId);

	let done = 0;
	for (let i = 0; i < pages.length; i++) {
		const pg = pages[i];
		if (!pg.text) continue;
		try {
			let useRef = refImage;
			let ok = false;
			for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
				const prompt = buildPageImagePrompt(pg.text, {
					bookTitle: data.title,
					cards,
					hasReferenceImage: !!useRef,
					prevPage: i > 0 ? pages[i - 1].text : undefined,
				});
				// P0-5 #3 schema 校验：卡片 + 本页 prompt 自包含完整才提交生图
				const v = validateChapterPage(cards, prompt, pg.text);
				if (!v.ok) {
					console.error(`[kidmagic][图生图] 第 ${pg.page_no} 页 schema 校验失败，降级纯文字：${v.errors.join("；")}`);
					break;
				}
				try {
					const { url } = await dashscopeGenerateImage(
						{ prompt, ...(useRef ? { referenceImageDataUri: useRef } : {}) },
						imgCfg,
					);
					// 外链会过期，下载落盘到 uploads 持久保存（回看绘本不再丢图）
					await updateBookPageGeneratedImage(db, pg.id, await saveRemoteImage(url));
					ok = true;
					done += 1;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const isRate = /429|RateQuota|rate limit|rate_limit/i.test(msg);
					const isSemantic =
						/HTTP 400|IPInfringementSuspect|IP infringement|content|sensitive|forbidden/i.test(msg);
					console.error(`[kidmagic][图生图] 第 ${pg.page_no} 页 第${attempt}次失败：${msg}`);
					if (isSemantic && useRef) {
						// 参考图疑似版权/内容违规 → 去掉参考图，降级纯文生图再试一次
						console.error(`[kidmagic][图生图] 第 ${pg.page_no} 页疑似内容违规，去掉参考图重试`);
						useRef = undefined;
						continue;
					}
					if (isSemantic) break; // 语义错误重试无意义，降级该页
					if (attempt < 3) {
						await new Promise((r) => setTimeout(r, isRate ? 2500 * attempt : 1200));
					}
				}
			}
		} catch (e) {
			console.error(
				`[kidmagic][图生图] 第 ${pg.page_no} 页未预期异常：${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	return done;
}

/** worker 处理器：生成配图 → 全部落 done（供 BullMQ Worker 回调调用） */
export async function chapterImageProcessor(db: Db, data: ChapterImageJobData): Promise<number> {
	const done = await generateChapterImages(db, data);
	await markBookDone(db, data.bookId);
	console.log(
		`[kidmagic][队列] 章节配图完成：${data.bookId.slice(0, 8)}/${data.chapterId.slice(0, 8)} 成功 ${done}/${data.title}`,
	);
	return done;
}
