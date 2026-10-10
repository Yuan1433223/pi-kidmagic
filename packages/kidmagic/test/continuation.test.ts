import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type FauxProviderRegistration,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createStoryAgent } from "../src/agent/story-agent.ts";
import { openDatabase, sqliteDbAdapter } from "../src/storage/db.ts";
import * as repo from "../src/storage/repo.ts";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

/** 内存 SQLite + Db 适配 */
function memDb() {
	return sqliteDbAdapter(openDatabase(":memory:"));
}

/**
 * P1 章节续写闭环（faux，离线）：
 * 第一章生成后写入 recap_summary → 续写开新 session 注入前情提要 →
 * 第二章挂同一本书（chapter_no=2，走 continuationChapterNo 兜底），书标题保留。
 */
describe("章节续写（P1）", () => {
	it("第一章写前情提要，第二章续到同一本书且章节号兜底为 2", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		faux.setResponses([
			// —— 第一章（3 条）——
			fauxAssistantMessage(
				[
					fauxToolCall("save_story_element", {
						elementType: "setting",
						content: "大森林",
						childWords: "小兔子住在大森林里",
					}),
					fauxToolCall("save_story_element", {
						elementType: "plotbeat",
						content: "小兔子迷路了",
						childWords: "跑出去就迷路了，天快黑了它有点害怕",
					}),
					fauxToolCall("check_skeleton", { gaps: [] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("我听到的故事是：小兔子在大森林迷路了。要不要做成绘本呀？"),
			fauxAssistantMessage(
				[
					fauxToolCall("save_book_title", { title: "小兔子找家" }),
					fauxToolCall("start_book_generation", { artworkId: "cover", title: "小兔子找家" }),
				],
				{ stopReason: "toolUse" },
			),
			// —— 第二章（3 条），start_book_generation 故意不传 chapterNo，验证兜底 ——
			fauxAssistantMessage(
				[
					fauxToolCall("save_story_element", {
						elementType: "plotbeat",
						content: "小兔子遇到了新朋友",
						childWords: "第二天小兔子又出去玩了，碰到一只新朋友",
					}),
					fauxToolCall("check_skeleton", { gaps: [] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("第二章我听到的是：小兔子遇到新朋友。要不要继续做第二章呀？"),
			fauxAssistantMessage(
				[
					fauxToolCall("save_book_title", { title: "小兔子找家·新朋友" }),
					fauxToolCall("start_book_generation", { artworkId: "cover", title: "小兔子找家·新朋友" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const db = memDb();

		// —— 第一章 ——
		const s1 = await createStoryAgent({ db, model: faux.getModel(), persona: "A" });
		await s1.agent.prompt("小兔子住在大森林里，跑出去就迷路了，天快黑了它有点害怕。");
		await s1.agent.prompt("好呀，做成绘本吧！");
		expect(s1.runtime.bookId).toBeDefined();
		expect(s1.runtime.chapterId).toBeDefined();
		const bookId = s1.runtime.bookId ?? "";

		// 第一章 recap_summary 已写入
		const ch1 = await repo.getChapter(db, s1.runtime.chapterId ?? "");
		expect(ch1?.recap_summary).toBeTruthy();
		expect((await repo.getLatestChapter(db, bookId))?.recap_summary).toBe(ch1?.recap_summary);

		// —— 第二章（续写：新 session + 注入前情提要）——
		const s2 = await createStoryAgent({
			db,
			model: faux.getModel(),
			continuation: { bookId, recapSummary: ch1?.recap_summary ?? "", chapterNo: 2 },
		});
		expect(s2.sessionId).not.toBe(s1.sessionId); // 会话边界：新 session
		expect(s2.runtime.bookId).toBe(bookId); // 续写挂到原书

		await s2.agent.prompt("第二天小兔子又出去玩了，碰到一只新朋友。");
		await s2.agent.prompt("好呀，继续做第二章吧！");

		// 第二章挂在同一本书，章节号=2（未传 chapterNo，走 continuationChapterNo 兜底）
		expect(s2.runtime.bookId).toBe(bookId);
		const latest = await repo.getLatestChapter(db, bookId);
		expect(latest?.chapter_no).toBe(2);
		expect(s2.runtime.chapterId).toBe(latest?.id);

		// 第二章有页，且为主角一致性可验证的孩子原话
		const pages = await repo.listPages(db, latest?.id ?? "");
		expect(pages.length).toBeGreaterThan(0);
		expect((await repo.childRawRatio(db, latest?.id ?? "")).ratio).toBe(1);

		// 书标题保留第一章标题，未被第二章标题覆盖
		expect((await repo.getBook(db, bookId))?.title).toBe("小兔子找家");

		// 两章各生成了一条前情提要（第二章的 recap 也已写入，供第三章续写）
		expect(latest?.recap_summary).toBeTruthy();
	});

	it("模型漏调 save_story_element 时，绘本兜底用孩子原话建页（不产出空绘本）", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		faux.setResponses([
			// 第一章：模型只调 magic_render + check_skeleton，漏调 save_story_element
			fauxAssistantMessage(
				[
					fauxToolCall("magic_render", { emotion: "curious", sceneHint: "森林" }),
					fauxToolCall("check_skeleton", { gaps: [] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("我听到小兔子在大森林迷路的故事啦。要不要做成绘本呀？"),
			fauxAssistantMessage(
				[
					fauxToolCall("save_book_title", { title: "小兔子找家" }),
					fauxToolCall("start_book_generation", { artworkId: "cover", title: "小兔子找家" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const db = memDb();
		const s = await createStoryAgent({ db, model: faux.getModel(), persona: "A" });
		// 孩子讲故事（未触发 save_story_element，但 user 原话会落 session_messages）
		await s.agent.prompt("小兔子住在大森林里，跑出去就迷路了，天快黑了它有点害怕。");
		await s.agent.prompt("好呀，做成绘本吧！");
		expect(s.runtime.chapterId).toBeDefined();

		// 兜底生效：绘本非空，且页全部来自孩子原话（child_raw）
		const pages = await repo.listPages(db, s.runtime.chapterId ?? "");
		expect(pages.length).toBeGreaterThan(0);
		expect(pages.every((p) => p.text_source === "child_raw")).toBe(true);
		expect((await repo.childRawRatio(db, s.runtime.chapterId ?? "")).ratio).toBe(1);
		// 前情提要非空且包含孩子原话片段
		const ch = await repo.getChapter(db, s.runtime.chapterId ?? "");
		expect(ch?.recap_summary).toContain("小兔子");
		// 兜底页不包含短句（打招呼/同意）
		expect(pages.some((p) => p.text.includes("好呀"))).toBe(false);
	});
});
