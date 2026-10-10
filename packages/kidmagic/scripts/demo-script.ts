/**
 * 9.2 固定剧本 demo（无 ASR、无 TTS、无前端）。
 *
 * 目的：用预设的"孩子台词"驱动故事 agent，端到端跑通
 *   素材上传 → S0 见面 → S1 倾听/魔法反馈 → S2 缺口推理 → S3 最少追问 → S4 概括确认 → 生成第一章，
 * 验证对话引擎、阶段机、白名单工具与作品库落库，而不是验证语音链路。
 *
 * 运行（在 packages/kidmagic 目录，PowerShell）：
 *   方式一（推荐，key 写入 .env）：复制 .env.example 为 .env，填入 QWEN_TOKEN_PLAN_CN_API_KEY，执行 npm run demo
 *   方式二（当前会话临时设置）：
 *     $env:QWEN_TOKEN_PLAN_CN_API_KEY = "你的阿里云百炼 Token Plan key"
 *     $env:QWEN_MODEL               = "qwen3.8-flash"  # 可选，默认即此（多模态 + 工具调用）
 *     $env:KIDMAGIC_PERSONA         = "A"             # 可选，A 琪琪老师 / B 动画伙伴
 *     npm run demo
 *   备选 OpenRouter：设置 OPENROUTER_API_KEY（或 KIDMAGIC_PROVIDER=openrouter）。
 *
 * 离线、不花钱地验证引擎逻辑请改用：npm run test（faux provider 冒烟测试）。
 */
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { qwenTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn";
import {
	createStoryAgent,
	repo,
	createQwenDedicatedProvider,
	QWEN_DEDICATED_PROVIDER_ID,
} from "../src/index.ts";
import { openDatabase, sqliteDbAdapter } from "../src/storage/db.ts";
import { insertAsset } from "../src/storage/repo.ts";
import type { Persona } from "../src/agent/stages.ts";

/** 固定剧本：一个 4-8 岁孩子的四段台词。第 2 段故意只讲到"迷路、害怕"，缺结尾，用来触发缺口追问。 */
const SCRIPT: string[] = [
	"琪琪老师好！",
	"我今天画了一只小兔子，它住在大森林里。有一天它偷偷跑出去玩，跑着跑着就找不到回家的路了，天快黑了，它有点害怕。",
	"后来有一只小松鼠听到小兔子在哭，就带它爬到一棵很高很高的树上，从树顶上看见了自己家的红屋顶，小松鼠就把它送回家啦！",
	"好呀好呀！书名就叫《小兔子找家》，用我画的小兔子当封面，帮我做成绘本吧！",
];

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((b): b is Extract<(typeof message.content)[number], { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
}

async function main(): Promise<void> {
	const persona: Persona = process.env.KIDMAGIC_PERSONA === "B" ? "B" : "A";

	const models = createModels();

	// Provider 选择（优先级从高到低）：
	//  1) 百炼「专属实例」：设了 QWEN_BASE_URL（llm-<id>.../compatible-mode/v1）+ 任一 qwen key
	//  2) 百炼「Token Plan 公共套餐网关」：设了 QWEN_TOKEN_PLAN_CN_API_KEY
	//  3) OpenRouter：设了 OPENROUTER_API_KEY（或 KIDMAGIC_PROVIDER=openrouter 强制）
	const forceOpenRouter = process.env.KIDMAGIC_PROVIDER === "openrouter";
	const dedicatedBaseUrl = process.env.QWEN_BASE_URL;
	const dedicatedKey =
		process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
	const qwenPlanKey = process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
	const openRouterKey = process.env.OPENROUTER_API_KEY;

	let providerId: string;
	let modelId: string;
	if (!forceOpenRouter && dedicatedBaseUrl && dedicatedKey) {
		modelId = process.env.QWEN_MODEL ?? process.env.KIDMAGIC_MODEL ?? "qwen3.8-max";
		models.setProvider(createQwenDedicatedProvider({ baseUrl: dedicatedBaseUrl, modelId }));
		providerId = QWEN_DEDICATED_PROVIDER_ID;
	} else if (!forceOpenRouter && qwenPlanKey) {
		models.setProvider(qwenTokenPlanCnProvider()); // 经 envApiKeyAuth 自动读取 QWEN_TOKEN_PLAN_CN_API_KEY
		providerId = "qwen-token-plan-cn";
		modelId = process.env.QWEN_MODEL ?? process.env.KIDMAGIC_MODEL ?? "qwen3.8-flash";
	} else if (openRouterKey) {
		models.setProvider(openrouterProvider()); // 经 envApiKeyAuth 自动读取 OPENROUTER_API_KEY
		providerId = "openrouter";
		modelId = process.env.OPENROUTER_MODEL ?? process.env.KIDMAGIC_MODEL ?? "google/gemini-2.5-flash";
	} else {
		console.error(
			[
				"未找到可用的模型配置，请三选一：",
				"  1) 百炼专属实例：设置 QWEN_BASE_URL 与 QWEN_API_KEY（或 DASHSCOPE_API_KEY）",
				"  2) 百炼 Token Plan 公共套餐：设置 QWEN_TOKEN_PLAN_CN_API_KEY",
				"  3) OpenRouter：设置 OPENROUTER_API_KEY（或 KIDMAGIC_PROVIDER=openrouter）",
				"离线验证引擎逻辑可不花钱运行：npm run test（faux 冒烟测试）。",
			].join("\n"),
		);
		process.exit(1);
	}

	const model = models.getModel(providerId, modelId);
	if (!model) {
		console.error(`模型 ${providerId}/${modelId} 未在本地 catalog 中找到，请用对应环境变量指定有效模型 id。`);
		process.exit(1);
	}
	console.log(`使用模型：${providerId}/${modelId}　人设：${persona}`);

	const rawDb = openDatabase("./kidmagic-demo.db");
	const db = sqliteDbAdapter(rawDb);
	const { agent, runtime, sessionId } = await createStoryAgent({
		db,
		model,
		persona,
		streamFn: models.streamSimple.bind(models),
	});

	// 模拟孩子在开口前先逐张上传了两幅画（真实产品由前端/素材管线写入）
	await insertAsset(db, { sessionId: runtime.sessionId, kind: "drawing", mimeType: "image/png", uri: "./demo-assets/rabbit.png" });
	await insertAsset(db, { sessionId: runtime.sessionId, kind: "drawing", mimeType: "image/png", uri: "./demo-assets/forest.png" });

	// 过程可视化：打印每次工具调用
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			console.log(`   〔工具〕${event.toolName} ${JSON.stringify(event.args)}`);
		}
	});

	for (const line of SCRIPT) {
		console.log(`\n🧒 孩子：${line}`);
		await agent.prompt(line);
		const assistants = agent.state.messages.filter((m) => m.role === "assistant") as AssistantMessage[];
		const reply = assistantText(assistants.at(-1));
		if (reply) console.log(`✨ 琪琪老师：${reply}`);
	}

	// —— 创作产物报告 ——
	console.log("\n================ 创作产物 ================");
	console.log(`会话：${sessionId}　最终阶段：${runtime.stage}　缺口追问轮次：${runtime.gapRoundCount}`);
	const book = runtime.bookId ? await repo.getBook(db, runtime.bookId) : undefined;
	console.log("绘本：", book);
	if (runtime.chapterId) {
		const pages = await repo.listPages(db, runtime.chapterId);
		for (const p of pages) console.log(`  P${p.page_no}　[${p.text_source}]　${p.text}`);
		const ratio = await repo.childRawRatio(db, runtime.chapterId);
		console.log(`主导性验收：孩子原话页 ${ratio.childRaw}/${ratio.total}，占比 ${(ratio.ratio * 100).toFixed(0)}%（门槛 60%）`);
	}
	console.log("故事元素：");
	for (const el of await repo.listStoryElements(db, sessionId)) {
		console.log(`  (${el.element_type}) ${el.content}　｜原话：${el.child_words}`);
	}
	const characters = (await db.query("SELECT name, appearance, personality FROM characters")) as unknown as {
		name: string;
		appearance: string;
		personality: string;
	}[];
	console.log("角色库：", characters);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
