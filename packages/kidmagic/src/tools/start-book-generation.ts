import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import {
	createBook,
	createChapter,
	getBook,
	insertBookPage,
	listStoryElements,
	markBookDone,
	markBookGenerating,
	setBookTitle,
	updateChapterRecap,
} from "../storage/repo.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";
import { mergeChildPages, splitRawStory } from "./paginate.ts";
import { buildRecapSummary } from "../agent/summary.ts";
import { resolveDashScopeImageConfig } from "../image/dashscope-image.ts";
import { generateChapterImages, type ChapterImageJobData } from "../jobs/image-jobs.ts";
import { IMAGE_QUEUE_NAME } from "../jobs/queue.ts";

const parameters = Type.Object({
	artworkId: Type.String(),
	title: Type.String(),
	chapterNo: Type.Optional(Type.Integer()),
});

type Params = Static<typeof parameters>;

/**
 * 触发绘本生成（P0：第一章 / 续写章节）。
 *
 * 文字排版（建书 → 建章 → 用孩子原话逐元素成页）始终**同步**完成，保证
 * childRawRatio 真实反映"孩子主导性"（门槛 ≥0.6）。
 *
 * 配图（P1 图生图 qwen-image-3.0）走 **P0-2 BullMQ 异步**：
 * - 队列可用 → 入队"章节配图" job，文字先落地、书标 generating，worker 后台串行生成，画布边生成边铺页；
 * - 无队列 / Redis 不可用 → 自动降级为同步图生图（不阻塞绘本出片，页面文字照常生成）。
 * 单页配图失败只降级为纯文字页，不阻塞整本。
 */
export function createStartBookGenerationTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "start_book_generation",
		description:
			"故事确认完整、孩子同意做成绘本后调用：把孩子讲的内容整理成第 N 章绘本（默认第一章）；只能在框架完整且孩子同意后调用",
		label: "生成绘本",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const { db, runtime } = deps;
			const chapterNo = params.chapterNo ?? runtime.continuationChapterNo ?? 1;

			// 封面容错：优先用模型指定且属于本会话的素材，否则回退到本会话最早上传的一张
			const explicit = (await db.query(
				"SELECT id FROM assets WHERE id = $1 AND session_id = $2",
				[params.artworkId, runtime.sessionId],
			))[0] as { id: string } | undefined;
			const fallback = (await db.query(
				"SELECT id FROM assets WHERE session_id = $1 ORDER BY created_at LIMIT 1",
				[runtime.sessionId],
			))[0] as { id: string } | undefined;
			const coverId = explicit?.id ?? fallback?.id ?? params.artworkId;

			// 1) 确保绘本存在并写入书名/封面原画
			if (!runtime.bookId) {
				runtime.bookId = await createBook(db, {
					sessionId: runtime.sessionId,
					title: params.title,
					coverAssetId: coverId,
				});
			} else {
				// 续写：保留原书标题（书名 = 整本书），仅当书暂无标题才用本章标题；更新封面原画
				const book = await getBook(db, runtime.bookId);
				if (!book?.title) await setBookTitle(db, runtime.bookId, params.title);
				await db.query("UPDATE books SET cover_asset_id = $1 WHERE id = $2", [coverId, runtime.bookId]);
			}

			// 2) 创建章节
			const chapterId = await createChapter(db, { bookId: runtime.bookId, chapterNo, title: params.title });

			// 3) 用孩子原话排版成页（P0.1 归并去重：消除子串重复与碎片，保留 child_raw 主导性）
			const elements = await listStoryElements(db, runtime.sessionId);
			const elsN = elements.length;
			let pages = mergeChildPages(
				elements.map((el) => ({ childWords: el.child_words, content: el.content })),
			);
			const mergePages = pages.length;
			let pageSource = elsN > 0 ? `elements(${elsN})` : "none";
			// 分页可靠性兜底：模型漏调/少调 save_story_element 时（孩子一口气讲完 → 元素不足），
			// 归并后可能只有 1 页整段。只要 <2 页，就用孩子原话（元素原话 ∪ user 消息）
			// 按句读切分补足多页，保证长故事不被压成单页。
			if (pages.length < 2) {
				const userMsgs = (await db.query(
					"SELECT content FROM session_messages WHERE session_id = $1 AND role = 'user' ORDER BY created_at",
					[runtime.sessionId],
				)) as unknown as { content: string }[];
				const joined = [
					elements.map((el) => el.child_words.trim()).filter(Boolean).join(""),
					...userMsgs.map((m) => m.content.trim()).filter((s) => s.length >= 10), // 跳过"琪琪老师好/好呀"等短句
				].join("");
				if (joined) {
					const alt = splitRawStory(joined);
					if (alt.length > pages.length) {
						pages = alt;
						pageSource = "splitRawStory";
					}
				}
			}
			// 分页决策日志（持续调试）：元素数 / 归并后页数 / 是否走句读切分兜底 / 最终页数
			console.log(
				`[绘本] 分页：story_elements=${elsN} → mergeChildPages=${mergePages} → 兜底=${pageSource} → final=${pages.length} 页`,
			);
			let pageNo = 1;
			for (const pg of pages) {
				await insertBookPage(db, {
					chapterId,
					pageNo: pageNo++,
					text: pg.text,
					textSource: pg.textSource,
					imageAssetId: null,
				});
			}
			// 兜底：没有任何故事元素时，至少产出一页（标记为连接词页，验收时会暴露主导性不足）
			if (pageNo === 1) {
				await insertBookPage(db, { chapterId, pageNo: 1, text: params.title, textSource: "connector" });
				pageNo = 2;
			}
			// P1.0：生成前情提要摘要，供下次续写注入（确定性拼接，见 summary.ts）
			await updateChapterRecap(db, chapterId, buildRecapSummary(params.title, pages));

			// 4) 配图：队列可用 → 异步；否则同步降级；无图生图配置 → 整章纯文字
			let imgNote = "";
			const imgCfg = resolveDashScopeImageConfig();
			if (imgCfg && pageNo > 1) {
				// P0-5 一致性：角色/场景卡由 worker 内从库重建（asset_clusters/characters/story_elements），
				// job 只带 id + 文本（可安全序列化进 Redis），卡片不进 job data。
				const jobData: ChapterImageJobData = {
					bookId: runtime.bookId,
					chapterId,
					sessionId: runtime.sessionId,
					title: params.title,
				};

				if (deps.imageQueue) {
					// 异步：文字先落地，书标 generating（前端画布据 status 边生成边铺页），配图后台进行
					await markBookGenerating(db, runtime.bookId);
					try {
						await deps.imageQueue.add(IMAGE_QUEUE_NAME, jobData);
						imgNote = "（文字已就绪，配图正在魔法生成中…）";
					} catch (err) {
						// Redis 不可用 → 降级同步，保证绘本能出片
						console.error(
							`[kidmagic][队列] 入队失败，降级同步图生图：${err instanceof Error ? err.message : String(err)}`,
						);
						const done = await generateChapterImages(db, jobData);
						await markBookDone(db, runtime.bookId);
						imgNote = done > 0 ? `（图生图已生成 ${done} 页）` : "";
					}
				} else {
					// 无队列（demo / 单机脚本）：同步串行生成 + 退避（历史行为，429 已修复）
					const done = await generateChapterImages(db, jobData);
					await markBookDone(db, runtime.bookId);
					imgNote = done > 0 ? `（图生图已生成 ${done} 页）` : "";
				}
			} else {
				await markBookDone(db, runtime.bookId);
			}

			runtime.chapterId = chapterId;
			runtime.stage = "S4";

			return textResult(
				`「${params.title}」第 ${chapterNo} 章做好啦，一共 ${pageNo - 1} 页，这是你自己讲出来的故事哦！${imgNote}`,
			);
		},
	};
}
