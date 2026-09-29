import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.ts";
import * as repo from "../src/storage/repo.ts";

const P0_TABLES = [
	"assets",
	"asset_clusters",
	"sessions",
	"session_messages",
	"story_elements",
	"characters",
	"books",
	"book_characters",
	"chapters",
	"book_pages",
];

describe("storage 作品库", () => {
	it("初始化 P0 十张表", () => {
		const db = openDatabase(":memory:");
		const rows = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as unknown as { name: string }[];
		const names = rows.map((r) => r.name);
		for (const table of P0_TABLES) {
			expect(names).toContain(table);
		}
	});

	it("角色库按名字去重，同名更新而非新增（跨故事可复用）", () => {
		const db = openDatabase(":memory:");
		const first = repo.upsertCharacter(db, { name: "小兔子", appearance: "白色", personality: "好奇" });
		const second = repo.upsertCharacter(db, { name: "小兔子", appearance: "长耳朵", personality: "勇敢" });
		expect(second).toBe(first);
		const character = repo.getCharacterByName(db, "小兔子");
		expect(character?.appearance).toBe("长耳朵");
		const count = (db.prepare("SELECT COUNT(*) AS n FROM characters").get() as { n: number }).n;
		expect(count).toBe(1);
	});

	it("主角与绘本多对多关联", () => {
		const db = openDatabase(":memory:");
		const sessionId = repo.createSession(db, "A");
		const characterId = repo.upsertCharacter(db, { name: "小兔子" });
		const bookId = repo.createBook(db, { sessionId });
		repo.linkBookCharacter(db, bookId, characterId, "protagonist");
		const rows = db
			.prepare("SELECT role FROM book_characters WHERE book_id = ? AND character_id = ?")
			.all(bookId, characterId) as unknown as { role: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe("protagonist");
	});

	it("主导性验收：child_raw 占比按页统计", () => {
		const db = openDatabase(":memory:");
		const sessionId = repo.createSession(db, "A");
		const bookId = repo.createBook(db, { sessionId });
		const chapterId = repo.createChapter(db, { bookId });
		repo.insertBookPage(db, { chapterId, pageNo: 1, text: "原话一", textSource: "child_raw" });
		repo.insertBookPage(db, { chapterId, pageNo: 2, text: "原话二", textSource: "child_raw" });
		repo.insertBookPage(db, { chapterId, pageNo: 3, text: "原话三", textSource: "child_raw" });
		repo.insertBookPage(db, { chapterId, pageNo: 4, text: "后来", textSource: "connector" });
		expect(repo.childRawRatio(db, chapterId)).toEqual({ childRaw: 3, total: 4, ratio: 0.75 });
	});

	it("故事元素保留孩子原话", () => {
		const db = openDatabase(":memory:");
		const sessionId = repo.createSession(db, "A");
		repo.insertStoryElement(db, {
			sessionId,
			elementType: "plotbeat",
			content: "主角迷路",
			childWords: "小兔子跑着跑着就找不到家了",
			orderIdx: 1,
		});
		const elements = repo.listStoryElements(db, sessionId);
		expect(elements).toHaveLength(1);
		expect(elements[0].child_words).toBe("小兔子跑着跑着就找不到家了");
	});
});
