import { describe, expect, it } from "vitest";
import { mergeChildPages, splitRawStory } from "../src/tools/paginate.ts";

describe("mergeChildPages（P0.1 分页归并去重）", () => {
	it("把 demo 中的 7 个元素归并为 5 页，去掉子串重复页", () => {
		const inputs = [
			{ childWords: "我今天画了一只小兔子，它住在大森林里。", content: "" },
			{ childWords: "它住在大森林里。", content: "" },
			{ childWords: "有一天它偷偷跑出去玩，跑着跑着就找不到回家的路了", content: "" },
			{ childWords: "天快黑了，它有点害怕。", content: "" },
			{ childWords: "后来有一只小松鼠听到小兔子在哭", content: "" },
			{ childWords: "就带它爬到一棵很高很高的树上，从树顶上看见了自己家的红屋顶，小松鼠就把它送回家啦！", content: "" },
			{ childWords: "爬到一棵很高很高的树上，从树顶上看见了自己家的红屋顶", content: "" },
		];
		const pages = mergeChildPages(inputs);

		expect(pages).toHaveLength(5);
		// 全为孩子原话，主导性不被破坏
		expect(pages.every((p) => p.textSource === "child_raw")).toBe(true);
		// 被去掉的两个重复页（"它住在大森林里"、"爬到一棵很高很高的树上…"）不再单独成页
		expect(pages.map((p) => p.text)).not.toContain("它住在大森林里。");
		expect(pages.map((p) => p.text)).not.toContain("爬到一棵很高很高的树上，从树顶上看见了自己家的红屋顶");
	});

	it("child_words 为空时退回元素 content 并标记 connector", () => {
		const pages = mergeChildPages([{ childWords: "  ", content: "从前有个小朋友" }]);
		expect(pages).toHaveLength(1);
		expect(pages[0].text).toBe("从前有个小朋友");
		expect(pages[0].textSource).toBe("connector");
	});

	it("空输入返回空数组", () => {
		expect(mergeChildPages([])).toEqual([]);
	});

	it("无重复的多个元素各自成页，顺序保持不变", () => {
		const pages = mergeChildPages([
			{ childWords: "小兔子住在大森林里", content: "" },
			{ childWords: "它偷偷跑出去玩", content: "" },
			{ childWords: "小松鼠帮它回了家", content: "" },
		]);
		expect(pages.map((p) => p.text)).toEqual([
			"小兔子住在大森林里",
			"它偷偷跑出去玩",
			"小松鼠帮它回了家",
		]);
	});
});

describe("splitRawStory（无 story_elements 时的兜底分页）", () => {
	it("一口气讲完的长段按句读切成多页，页数不超上限", () => {
		const text =
			"小鸟叫嘻嘻，他今天早上去森林的果林里摘苹果。他到果树林，开始摘苹果，摘了两个后，发现自己拿不下了。就找树枝编了一个果篮，最后装了一筐就回家了。";
		const pages = splitRawStory(text, 6);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.length).toBeLessThanOrEqual(6);
		// 每页都是孩子原话，且拼接后覆盖原文
		expect(pages.every((p) => p.textSource === "child_raw")).toBe(true);
		expect(pages.map((p) => p.text).join("").replace(/\s/g, "")).toContain(
			text.replace(/\s/g, "").slice(0, 10),
		);
	});

	it("短句（1 句）回退为整段一页", () => {
		expect(splitRawStory("小鸟飞走了", 6)).toEqual([{ text: "小鸟飞走了", textSource: "child_raw" }]);
	});

	it("空输入返回空数组", () => {
		expect(splitRawStory("   ", 6)).toEqual([]);
	});
});
