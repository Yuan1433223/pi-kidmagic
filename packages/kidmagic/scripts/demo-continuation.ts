/**
 * P1-B 章节续写真机 demo（无 ASR、无 TTS、无前端）。
 *
 * 目的：验证产品生命周期钩子——孩子第二次回来"接着讲下一章"。
 *   第一次会话：跑完第一章，生成绘本 + 前情提要 recap_summary；
 *   第二次会话：新 session + 注入上一章前情提要，续写第二章，挂到同一本书。
 *
 * 运行（在 packages/kidmagic 目录，PowerShell）：
 *   复制 .env.example 为 .env，填好 key 后：npm run demo:continuation
 *   或：node --env-file-if-exists=.env --experimental-strip-types scripts/demo-continuation.ts
 *   环境变量同 demo：QWEN_BASE_URL/QWEN_API_KEY 或 QWEN_TOKEN_PLAN_CN_API_KEY 或 OPENROUTER_API_KEY，
 *   KIDMAGIC_PERSONA=A|B，QWEN_MODEL/KIDMAGIC_MODEL 可选。
 */
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { qwenTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn";
import {
	createStoryAgent,
	repo,
	createQwenDedicatedProvider,
	QWEN_DEDICATED_PROVIDER_ID,
	type StoryAgentHandle,
} from "../src/index.ts";
import { openDatabase, sqliteDbAdapter } from "../src/storage/db.ts";
import { insertAsset } from "../src/storage/repo.ts";
import type { Persona } from "../src/agent/stages.ts";

/** 第一章固定剧本（同 demo-script）：4-8 岁孩子，第 2 段缺结尾，触发缺口追问。 */
const CH1_SCRIPT: string[] = [
	"琪琪老师好！",
	"我今天画了一只小兔子，它住在大森林里。有一天它偷偷跑出去玩，跑着跑着就找不到回家的路了，天快黑了，它有点害怕。",
	"后来有一只小松鼠听到小兔子在哭，就带它爬到一棵很高很高的树上，从树顶上看见了自己家的红屋顶，小松鼠就把它送回家啦！",
	"好呀好呀！书名就叫《小兔子找家》，用我画的小兔子当封面，帮我做成绘本吧！",
];

/** 第二章固定剧本：孩子第二次回来，延续主角小兔子，讲新的冒险。 */
const CH2_SCRIPT: string[] = [
	"琪琪老师好！我今天想接着讲小兔子的故事。",
	"第二天早上，小兔子又偷偷溜出去玩了。它跑到一个大花园里，里面有一只胖乎乎的刺猬正在睡觉。",
	"刺猬被吵醒了，吓了一跳。小兔子说：别怕别怕，我是来找新朋友的。它们俩在花园里玩了一整天，追蝴蝶、滚草地，太阳下山才回家。",
	"好呀！这本书还是叫《小兔子找家》，今天这章就叫《花园里的新朋友》，帮我做成绘本吧！",
];

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((b): b is Extract<(typeof message.content)[number], { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
}

/** 跑一段固定剧本，打印孩子台词 + 老师回复 + 工具调用 */
async function runScript(handle: StoryAgentHandle, script: string[], teacherName: string): Promise<void> {
	for (const line of script) {
		console.log(`\n🧒 孩子：${line}`);
		await handle.agent.prompt(line);
		const assistants = handle.agent.state.messages.filter((m) => m.role === "assistant") as AssistantMessage[];
		const reply = assistantText(assistants.at(-1));
		if (reply) console.log(`✨ ${teacherName}：${reply}`);
	}
}

function resolveProvider(models: ReturnType<typeof createModels>): { providerId: string; modelId: string } {
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
	console.error(
		[
			"未找到可用的模型配置，请三选一：",
			"  1) 百炼专属实例：设置 QWEN_BASE_URL 与 QWEN_API_KEY（或 DASHSCOPE_API_KEY）",
			"  2) 百炼 Token Plan 公共套餐：设置 QWEN_TOKEN_PLAN_CN_API_KEY",
			"  3) OpenRouter：设置 OPENROUTER_API_KEY（或 KIDMAGIC_PROVIDER=openrouter）",
		].join("\n"),
	);
	process.exit(1);
}

async function main(): Promise<void> {
	const persona: Persona = process.env.KIDMAGIC_PERSONA === "B" ? "B" : "A";
	const teacherName = persona === "A" ? "琪琪老师" : "动画伙伴";
	const models = createModels();
	const { providerId, modelId } = resolveProvider(models);
	const model = models.getModel(providerId, modelId);
	if (!model) {
		console.error(`模型 ${providerId}/${modelId} 未在本地 catalog 中找到，请用对应环境变量指定有效模型 id。`);
		process.exit(1);
	}
	console.log(`使用模型：${providerId}/${modelId}　人设：${persona}`);

	const rawDb = openDatabase("./kidmagic-demo.db");
	const db = sqliteDbAdapter(rawDb);

	// ============ 第一次会话：第一章 ============
	console.log("\n══════════ 第一次会话：第一章 ══════════");
	const s1 = await createStoryAgent({ db, model, persona, streamFn: models.streamSimple.bind(models) });
	// 模拟孩子开口前先上传了两幅画
	await insertAsset(db, { sessionId: s1.sessionId, kind: "drawing", mimeType: "image/png", uri: "./demo-assets/rabbit.png" });
	await insertAsset(db, { sessionId: s1.sessionId, kind: "drawing", mimeType: "image/png", uri: "./demo-assets/forest.png" });
	s1.agent.subscribe((event) => {
		if (event.type === "tool_execution_start") console.log(`   〔工具〕${event.toolName} ${JSON.stringify(event.args)}`);
	});

	await runScript(s1, CH1_SCRIPT, teacherName);

	console.log("\n—— 第一章产物 ——");
	console.log(`会话：${s1.sessionId}　阶段：${s1.runtime.stage}　缺口轮次：${s1.runtime.gapRoundCount}`);
	const book = s1.runtime.bookId ? await repo.getBook(db, s1.runtime.bookId) : undefined;
	console.log("绘本：", book);
	if (s1.runtime.chapterId) {
		const pages = await repo.listPages(db, s1.runtime.chapterId);
		for (const p of pages) console.log(`  P${p.page_no}　[${p.text_source}]　${p.text}`);
		const ratio = await repo.childRawRatio(db, s1.runtime.chapterId);
		console.log(`主导性：孩子原话 ${ratio.childRaw}/${ratio.total}（门槛 60%）`);
	}

	// 取最新章前情提要作为续写注入
	const latest = s1.runtime.bookId ? await repo.getLatestChapter(db, s1.runtime.bookId) : undefined;
	const recap = latest?.recap_summary ?? "";
	console.log(`\n前情提要（recap_summary）：${recap || "（空）"}`);
	if (!s1.runtime.bookId || !recap) {
		console.error("第一章未成功产出书或前情提要，无法续写。请检查 key/模型后重试。");
		process.exit(1);
	}

	// ============ 第二次会话：续写第二章（新 session + 注入前情提要） ============
	console.log("\n══════════ 第二次会话：续写第二章 ══════════");
	const s2 = await createStoryAgent({
		db,
		model,
		persona,
		streamFn: models.streamSimple.bind(models),
		continuation: { bookId: s1.runtime.bookId, recapSummary: recap, chapterNo: 2 },
	});
	console.log(`新会话：${s2.sessionId}　续写挂书：${s2.runtime.bookId}`);
	s2.agent.subscribe((event) => {
		if (event.type === "tool_execution_start") console.log(`   〔工具〕${event.toolName} ${JSON.stringify(event.args)}`);
	});

	await runScript(s2, CH2_SCRIPT, teacherName);

	console.log("\n—— 第二章产物 ——");
	console.log(`会话：${s2.sessionId}　阶段：${s2.runtime.stage}　缺口轮次：${s2.runtime.gapRoundCount}`);
	const ch2 = s2.runtime.chapterId ? await repo.getChapter(db, s2.runtime.chapterId) : undefined;
	console.log("最新章节：", ch2);
	if (s2.runtime.chapterId) {
		const pages = await repo.listPages(db, s2.runtime.chapterId);
		for (const p of pages) console.log(`  P${p.page_no}　[${p.text_source}]　${p.text}`);
		const ratio = await repo.childRawRatio(db, s2.runtime.chapterId);
		console.log(`主导性：孩子原话 ${ratio.childRaw}/${ratio.total}（门槛 60%）`);
	}

	// —— 整本书现状 ——
	console.log("\n================ 全书现状 ================");
	console.log("书标题：", (await repo.getBook(db, s1.runtime.bookId!))?.title, "（应保留第一章书名，不被第二章覆盖）");
	const chs = (await db.query(
		"SELECT chapter_no, title, recap_summary FROM chapters WHERE book_id = $1 ORDER BY chapter_no",
		[s1.runtime.bookId],
	)) as unknown as { chapter_no: number; title: string; recap_summary: string }[];
	for (const c of chs) console.log(`  第${c.chapter_no}章　「${c.title}」　recap=${c.recap_summary.slice(0, 40)}…`);
	console.log("\n验证要点：第二章 chapter_no=2、与第一章同一本书、书标题未变、两章各自有前情提要（供第三章续写）。");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
