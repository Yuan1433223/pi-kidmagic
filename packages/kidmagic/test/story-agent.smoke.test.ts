import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type FauxProviderRegistration,
} from "@earendil-works/pi-ai/compat";
import { Type, type TSchema } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createStoryAgent } from "../src/agent/story-agent.ts";
import { openDatabase } from "../src/storage/db.ts";
import * as repo from "../src/storage/repo.ts";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

/**
 * 固定剧本端到端冒烟（faux provider，离线、确定性、不花钱）：
 *  讲述(缺结尾) → 角色卡/元素/魔法反馈/缺口推理 → 就缺口追问
 *  → 孩子补结尾、框架完整 → 概括并询问 → 孩子同意 → 起名 + 生成第一章。
 */
describe("故事 agent 阶段机（faux 固定剧本）", () => {
	it("跑通 S0→S4 并生成由孩子原话构成的第一章", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		faux.setResponses([
			// A：听到讲述 → 角色卡 + 场景/情节 + 魔法反馈 + 缺口推理（缺结尾）
			fauxAssistantMessage(
				[
					fauxToolCall("build_character_card", {
						name: "小兔子",
						appearance: "长耳朵的小白兔",
						personality: "好奇又有点胆小",
					}),
					fauxToolCall("save_story_element", {
						elementType: "setting",
						content: "大森林",
						childWords: "它住在大森林里",
					}),
					fauxToolCall("save_story_element", {
						elementType: "plotbeat",
						content: "小兔子迷路了",
						childWords: "跑着跑着找不到回家的路了，它有点害怕",
					}),
					fauxToolCall("magic_render", { emotion: "curious", sceneHint: "森林" }),
					fauxToolCall("check_skeleton", { gaps: ["resolution"] }),
				],
				{ stopReason: "toolUse" },
			),
			// B：就"结尾"缺口向孩子追问（纯文本，把控制权交还孩子）
			fauxAssistantMessage("那后来小兔子怎么样了呀？有没有谁来帮帮它？"),
			// C：孩子补结尾 → 记录 resolution + 再检查（框架完整）
			fauxAssistantMessage(
				[
					fauxToolCall("save_story_element", {
						elementType: "resolution",
						content: "小松鼠帮小兔子回家",
						childWords: "小松鼠带它爬上高树，看到了家的红屋顶，就回家啦",
					}),
					fauxToolCall("check_skeleton", { gaps: [] }),
				],
				{ stopReason: "toolUse" },
			),
			// D：用孩子原话概括并请求确认（纯文本，等孩子同意）
			fauxAssistantMessage("我听到的故事是：小兔子在森林迷路，小松鼠帮它回了家。要不要把它做成你的绘本呀？"),
			// E：孩子同意 → 起名 + 生成第一章
			fauxAssistantMessage(
				[
					fauxToolCall("save_book_title", { title: "小兔子找家" }),
					fauxToolCall("start_book_generation", { artworkId: "asset-cover", title: "小兔子找家" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const db = openDatabase(":memory:");
		const { agent, runtime, sessionId } = createStoryAgent({ db, model: faux.getModel(), persona: "A" });

		await agent.prompt("我今天画了一只小兔子，它住在大森林里，跑出去玩就迷路了，天快黑了它有点害怕。");
		expect(runtime.stage).toBe("S3");
		expect(runtime.gapRoundCount).toBe(1);

		await agent.prompt("后来小松鼠听到它在哭，带它爬上高树，看见了家的红屋顶，把它送回家啦！");
		expect(runtime.stage).toBe("S4");
		expect(runtime.bookId).toBeUndefined(); // 尚未确认，不应提前生成

		await agent.prompt("好呀！书名就叫《小兔子找家》，帮我做成绘本吧！");

		// 阶段与会话
		expect(runtime.stage).toBe("S4");
		expect(runtime.bookId).toBeDefined();
		expect(runtime.chapterId).toBeDefined();
		const session = db.prepare("SELECT stage, status, current_book_id FROM sessions WHERE id = ?").get(sessionId) as {
			stage: string;
			status: string;
			current_book_id: string | null;
		};
		expect(session.stage).toBe("S4");
		expect(session.status).toBe("completed");

		// 绘本与页
		const book = repo.getBook(db, runtime.bookId ?? "");
		expect(book?.title).toBe("小兔子找家");
		expect(book?.status).toBe("done");
		const pages = repo.listPages(db, runtime.chapterId ?? "");
		expect(pages.length).toBe(3); // setting / plotbeat / resolution 各一页，均为孩子原话
		const ratio = repo.childRawRatio(db, runtime.chapterId ?? "");
		expect(ratio.ratio).toBe(1);

		// 角色库
		const character = repo.getCharacterByName(db, "小兔子");
		expect(character).toBeDefined();

		// 对话已落库（家长回放数据源）
		const messages = db
			.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?")
			.get(sessionId) as { n: number };
		expect(messages.n).toBeGreaterThan(0);
	});

	it("缺口追问最多 2 轮：超过上限后即使仍有缺口也进入概括", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		faux.setResponses([
			// 第 1 轮：缺 setting 与 conflict
			fauxAssistantMessage([fauxToolCall("check_skeleton", { gaps: ["setting", "conflict"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("故事发生在哪里呀？"),
			// 第 2 轮：仍缺 conflict
			fauxAssistantMessage([fauxToolCall("check_skeleton", { gaps: ["conflict"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("那小兔子遇到什么事了呢？"),
			// 第 3 次检查：仍缺 conflict，但已达 2 轮上限 → S4，概括收尾
			fauxAssistantMessage([fauxToolCall("check_skeleton", { gaps: ["conflict"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("那我们先用你讲的这些把故事整理出来，以后还能再补哦。"),
		]);

		const db = openDatabase(":memory:");
		const { agent, runtime } = createStoryAgent({ db, model: faux.getModel() });

		await agent.prompt("有一只小兔子。");
		await agent.prompt("在一个地方。");
		await agent.prompt("嗯我想不到更多了。");

		expect(runtime.gapRoundCount).toBe(2);
		expect(runtime.stage).toBe("S4");
	});

	it("非白名单工具被 beforeToolCall 拦截且不执行", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		let executed = false;
		const dangerous: AgentTool<TSchema, unknown> = {
			name: "shell",
			label: "shell",
			description: "should be blocked",
			parameters: Type.Object({}),
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "ran" }], details: undefined };
			},
		};
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("shell", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("好的"),
		]);

		const db = openDatabase(":memory:");
		const { agent } = createStoryAgent({ db, model: faux.getModel() });
		agent.state.tools = [...agent.state.tools, dangerous];

		await agent.prompt("帮我执行 shell");

		expect(executed).toBe(false);
		const toolResults = agent.state.messages.filter(
			(m): m is ToolResultMessage => m.role === "toolResult",
		);
		expect(toolResults.some((m) => m.isError === true)).toBe(true);
	});
});
