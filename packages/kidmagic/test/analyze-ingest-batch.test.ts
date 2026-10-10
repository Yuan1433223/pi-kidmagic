import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKidmagicTools } from "../src/tools/index.ts";
import { createRuntime } from "../src/agent/stages.ts";
import { openDatabase, sqliteDbAdapter } from "../src/storage/db.ts";
import type { Db } from "../src/storage/db-pg.ts";
import * as repo from "../src/storage/repo.ts";

const PNG = "fake-png-bytes";

/** 内存 SQLite + Db 适配 */
function memDb() {
	return sqliteDbAdapter(openDatabase(":memory:"));
}

describe("analyze_ingest_batch 视觉理解聚类（离线，mock fetch）", () => {
	let uploadDir = "";
	let db: Db;

	const origFetch = globalThis.fetch;
	const origBase = process.env.QWEN_BASE_URL;
	const origKey = process.env.QWEN_API_KEY;
	const origUploads = process.env.KIDMAGIC_UPLOADS;

	async function setupDb(): Promise<void> {
		db = memDb();
		const sessionId = await repo.createSession(db, "A");
		await repo.createBook(db, { sessionId, title: "测试书" });
		// 工具读 sessions.current_book_id 定位书
		process.env.QWEN_BASE_URL = "https://mock.example/v1";
		process.env.QWEN_API_KEY = "test-key";
		process.env.KIDMAGIC_UPLOADS = uploadDir;
		return;
	}

	function writeUpload(file: string, bytes: string): void {
		mkdirSync(uploadDir, { recursive: true });
		writeFileSync(join(uploadDir, file), bytes);
	}

	async function makeTool(db_: Db) {
		const sessionId = (await db_.query("SELECT id FROM sessions LIMIT 1"))[0] as { id: string };
		const runtime = createRuntime(sessionId.id, "A");
		const tools = createKidmagicTools({ db: db_, runtime });
		const tool = tools.find((t) => t.name === "analyze_ingest_batch");
		if (!tool) throw new Error("工具未注册");
		return { tool, runtime };
	}

	function installFetchMock(responses: string[]): ReturnType<typeof vi.fn> {
		const fn = vi.fn();
		for (const body of responses) {
			fn.mockImplementationOnce(async () =>
				new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 }),
			);
		}
		vi.stubGlobal("fetch", fn);
		return fn;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
		process.env.QWEN_BASE_URL = origBase;
		process.env.QWEN_API_KEY = origKey;
		process.env.KIDMAGIC_UPLOADS = origUploads;
		if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
		uploadDir = "";
	});

	it("无已确认图片时不调用模型，直接返回提示", async () => {
		uploadDir = join(tmpdir(), `kidmagic-test-${Date.now()}`);
		await setupDb();
		const sessionId = (await db.query("SELECT id FROM sessions LIMIT 1"))[0] as { id: string };
		const bookId = (await db.query("SELECT current_book_id FROM sessions LIMIT 1"))[0] as { current_book_id: string };
		// 建一个 pending 的 ingest（未确认）
		await repo.insertIngestItem(db, {
			sessionId: sessionId.id,
			bookId: bookId.current_book_id,
			batchNo: 1,
			mimeType: "image/png",
			uri: "uploads/a.png",
		});
		const fn = installFetchMock(['[{"type":"character","label":"x"}]']);
		const { tool, runtime } = await makeTool(db);

		const result = await tool.execute("t1", { batchNo: 1 });
		const text = (result.content[0] as { text: string }).text;

		expect(fn).not.toHaveBeenCalled();
		expect(text).toContain("没有已确认");
		expect(runtime).toBeDefined();
	});

	it("两张图同一角色 → 每张各调一次模型，聚类合并为 1 组 character", async () => {
		uploadDir = join(tmpdir(), `kidmagic-test-${Date.now()}`);
		await setupDb();
		const sessionId = (await db.query("SELECT id FROM sessions LIMIT 1"))[0] as { id: string };
		const bookId = (await db.query("SELECT current_book_id FROM sessions LIMIT 1"))[0] as { current_book_id: string };
		const bid = bookId.current_book_id;
		writeUpload("a.png", PNG);
		writeUpload("b.png", PNG);
		const batch = await repo.nextIngestBatchNo(db, bid);
		await repo.insertIngestItem(db, { sessionId: sessionId.id, bookId: bid, batchNo: batch, mimeType: "image/png", uri: "uploads/a.png" });
		await repo.insertIngestItem(db, { sessionId: sessionId.id, bookId: bid, batchNo: batch, mimeType: "image/png", uri: "uploads/b.png" });
		await repo.confirmIngestBatch(db, bid, batch);

		const fn = installFetchMock([
			'[{"type":"character","label":"小兔子"}]',
			'[{"type":"character","label":"小兔子"},{"type":"setting","label":"大森林"}]',
		]);
		const { tool, runtime } = await makeTool(db);

		const result = await tool.execute("t1", { batchNo: batch });
		const text = (result.content[0] as { text: string }).text;

		expect(fn).toHaveBeenCalledTimes(2); // 每张图一次
		expect(text).toContain("小兔子");
		expect(text).toContain("大森林");
		expect(runtime).toBeDefined();

		// 2 个 asset
		const assets = (await db.query("SELECT COUNT(*) AS n FROM assets WHERE session_id = $1", [sessionId.id]))[0] as { n: unknown };
		expect(Number(assets.n)).toBe(2);
		// character 小兔子合并为 1 组，含 2 个 asset
		const cluster = (await db.query(
			"SELECT asset_ids, confirmed FROM asset_clusters WHERE label = $1 AND cluster_type='character'",
			["小兔子"],
		))[0] as { asset_ids: string; confirmed: number };
		expect(cluster).toBeDefined();
		expect((JSON.parse(cluster.asset_ids) as string[]).length).toBe(2);
		expect(cluster.confirmed).toBe(0); // 半自动，未确认
	});

	it("模型返回非 JSON 时容错为失败提示，不抛异常", async () => {
		uploadDir = join(tmpdir(), `kidmagic-test-${Date.now()}`);
		await setupDb();
		const sessionId = (await db.query("SELECT id FROM sessions LIMIT 1"))[0] as { id: string };
		const bookId = (await db.query("SELECT current_book_id FROM sessions LIMIT 1"))[0] as { current_book_id: string };
		writeUpload("a.png", PNG);
		const batch = await repo.nextIngestBatchNo(db, bookId.current_book_id);
		await repo.insertIngestItem(db, { sessionId: sessionId.id, bookId: bookId.current_book_id, batchNo: batch, mimeType: "image/png", uri: "uploads/a.png" });
		await repo.confirmIngestBatch(db, bookId.current_book_id, batch);

		installFetchMock(["对不起，我看不清这幅画。"]); // 无 JSON
		const { tool } = await makeTool(db);

		const result = await tool.execute("t1", { batchNo: batch });
		const text = (result.content[0] as { text: string }).text;

		expect(text).toContain("没认出");
	});
});
