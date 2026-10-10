import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/agent/stages.ts";
import { openDatabase, sqliteDbAdapter } from "../src/storage/db.ts";
import * as repo from "../src/storage/repo.ts";
import { createStartBookGenerationTool } from "../src/tools/start-book-generation.ts";
import { dashscopeGenerateImage, resolveImageBaseUrl } from "../src/image/dashscope-image.ts";

const origBase = process.env.QWEN_BASE_URL;
const origKey = process.env.QWEN_API_KEY;
const origDisabled = process.env.KIDMAGIC_IMAGE_DISABLED;

/** 内存 SQLite + Db 适配 */
function memDb() {
	return sqliteDbAdapter(openDatabase(":memory:"));
}

afterEach(() => {
	vi.unstubAllGlobals();
	process.env.QWEN_BASE_URL = origBase;
	process.env.QWEN_API_KEY = origKey;
	process.env.KIDMAGIC_IMAGE_DISABLED = origDisabled;
});

describe("resolveImageBaseUrl", () => {
	it("从 chat baseUrl 推导专属实例 host 根", () => {
		expect(resolveImageBaseUrl("https://llm-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).toBe(
			"https://llm-x.cn-beijing.maas.aliyuncs.com",
		);
	});
});

describe("dashscopeGenerateImage 异步任务（mock）", () => {
	it("专属实例同步返回图片（choices[0].message.content[0].image）时直接取图，不轮询", async () => {
		const fetchMock = vi.fn().mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({
						output: {
							choices: [{ message: { content: [{ type: "image", image: "http://img/sync.png" }] } }],
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { url } = await dashscopeGenerateImage(
			{ prompt: "小兔子" },
			{ baseUrl: "https://mock.example", apiKey: "k", modelId: "qwen-image-3.0", size: "1024*1024" },
		);
		expect(url).toBe("http://img/sync.png");
		expect(fetchMock).toHaveBeenCalledTimes(1); // 无轮询
	});

	it("提交→轮询 PENDING→SUCCEEDED 取图", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(
				async () =>
					new Response(JSON.stringify({ output: { task_id: "t1", task_status: "PENDING" } }), { status: 200 }),
			) // 提交
			.mockImplementationOnce(
				async () =>
					new Response(JSON.stringify({ output: { task_status: "PENDING" } }), { status: 200 }),
			) // 轮询1
			.mockImplementationOnce(
				async () =>
					new Response(
						JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{ url: "http://img/x.png" }] } }),
						{ status: 200 },
					),
			); // 轮询2
		vi.stubGlobal("fetch", fetchMock);

		const { url } = await dashscopeGenerateImage(
			{ prompt: "小兔子" },
			{ baseUrl: "https://mock.example", apiKey: "k", modelId: "qwen-image-3.0", size: "1024*1024" },
		);
		expect(url).toBe("http://img/x.png");
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// 提交请求体含 model/size/prompt
		const submitCall = fetchMock.mock.calls[0];
		const body = JSON.parse(String(submitCall[1]?.body));
		expect(body.model).toBe("qwen-image-3.0");
		expect(body.parameters.size).toBe("1024*1024");
		expect(body.input.messages[0].content[0].text).toBe("小兔子");
	});

	it("任务 FAILED 时抛错", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementationOnce(
					async () =>
						new Response(JSON.stringify({ output: { task_id: "t2", task_status: "PENDING" } }), { status: 200 }),
				)
				.mockImplementationOnce(
					async () =>
						new Response(JSON.stringify({ output: { task_status: "FAILED", message: "bad" } }), { status: 200 }),
				),
		);
		await expect(
			dashscopeGenerateImage({ prompt: "x" }, { baseUrl: "https://mock.example", apiKey: "k", modelId: "m" }),
		).rejects.toThrow("任务失败");
	});
});

describe("start_book_generation 图生图接入（mock）", () => {
	it("生成文字页后为每页生成图并写回 generated_image_uri", async () => {
		process.env.QWEN_BASE_URL = "https://llm-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
		process.env.QWEN_API_KEY = "test-key";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown) => {
				const u = String(url);
				if (u.includes("/generation"))
					return new Response(JSON.stringify({ output: { task_id: "t-" + Date.now() + Math.random(), task_status: "PENDING" } }), { status: 200 });
				if (u.includes("/tasks/"))
					return new Response(
						JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{ url: "http://img/x.png" }] } }),
						{ status: 200 },
					);
				if (u.startsWith("http://img/"))
					return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
				throw new Error("unexpected url " + u);
			}),
		);

		const db = memDb();
		const sessionId = await repo.createSession(db, "A");
		const runtime = createRuntime(sessionId, "A");
		await repo.insertStoryElement(db, { sessionId, elementType: "setting", content: "大森林", childWords: "它住在大森林里" });
		await repo.insertStoryElement(db, { sessionId, elementType: "plotbeat", content: "迷路", childWords: "小兔子迷路了" });

		const tool = createStartBookGenerationTool({ db, runtime });
		const result = await tool.execute("t1", { artworkId: "cover", title: "小兔子找家" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("图生图已生成");
		const chapterId = runtime.chapterId ?? "";
		const pages = await repo.listPages(db, chapterId);
		expect(pages.length).toBe(2);
		for (const p of pages) {
			const row = (await db.query("SELECT generated_image_uri FROM book_pages WHERE id = $1", [p.id]))[0] as { generated_image_uri: string | null };
			expect(row.generated_image_uri).toMatch(/^uploads\/.+\.png$/); // 图生图结果已落盘为本地 uri
		}
	});

	it("未配置图生图（无 key）时只排版文字，不调用 fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		process.env.QWEN_BASE_URL = "";
		process.env.QWEN_API_KEY = "";

		const db = memDb();
		const sessionId = await repo.createSession(db, "A");
		const runtime = createRuntime(sessionId, "A");
		await repo.insertStoryElement(db, { sessionId, elementType: "setting", content: "大森林", childWords: "它住在大森林里" });

		const tool = createStartBookGenerationTool({ db, runtime });
		const result = await tool.execute("t1", { artworkId: "cover", title: "小兔子找家" });
		const text = (result.content[0] as { text: string }).text;

		expect(text).not.toContain("图生图");
		expect(fetchMock).not.toHaveBeenCalled();
		const pages = await repo.listPages(db, runtime.chapterId ?? "");
		for (const p of pages) {
			const row = (await db.query("SELECT generated_image_uri FROM book_pages WHERE id = $1", [p.id]))[0] as { generated_image_uri: string | null };
			expect(row.generated_image_uri).toBeNull();
		}
	});
});
