import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import {
	createBook,
	createChapter,
	insertBookPage,
	listStoryElements,
	markBookDone,
	setBookTitle,
} from "../storage/repo.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({
	artworkId: Type.String(),
	title: Type.String(),
	chapterNo: Type.Optional(Type.Integer()),
});

type Params = Static<typeof parameters>;

/**
 * 触发绘本生成（P0：第一章）。
 *
 * P0 不调用图生图，而是把已记录的故事元素按顺序排版成页：
 * - 每页文字优先用孩子原话（child_words），text_source=child_raw；
 * - AI 只允许加连接词，不允许新增情节（无孩子原话的元素不单独成情节页）；
 * - 这样 childRawRatio 真实反映"孩子主导性"（门槛 ≥0.6）。
 * 图生图（P1 封面原画 + P2-P5 主角一致性）在此之上叠加，失败退回原画排版。
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
			const chapterNo = params.chapterNo ?? 1;

			// 封面容错：优先用模型指定且属于本会话的素材，否则回退到本会话最早上传的一张
			const explicit = db
				.prepare("SELECT id FROM assets WHERE id = ? AND session_id = ?")
				.get(params.artworkId, runtime.sessionId) as { id: string } | undefined;
			const fallback = db
				.prepare("SELECT id FROM assets WHERE session_id = ? ORDER BY created_at LIMIT 1")
				.get(runtime.sessionId) as { id: string } | undefined;
			const coverId = explicit?.id ?? fallback?.id ?? params.artworkId;

			// 1) 确保绘本存在并写入书名/封面原画
			if (!runtime.bookId) {
				runtime.bookId = createBook(db, {
					sessionId: runtime.sessionId,
					title: params.title,
					coverAssetId: coverId,
				});
			} else {
				setBookTitle(db, runtime.bookId, params.title);
				db.prepare("UPDATE books SET cover_asset_id = ? WHERE id = ?").run(coverId, runtime.bookId);
			}

			// 2) 创建章节
			const chapterId = createChapter(db, { bookId: runtime.bookId, chapterNo, title: params.title });

			// 3) 用孩子原话逐元素排版成页
			const elements = listStoryElements(db, runtime.sessionId);
			let pageNo = 1;
			for (const el of elements) {
				const text = el.child_words.trim() || el.content;
				const source = el.child_words.trim() ? "child_raw" : "connector";
				insertBookPage(db, {
					chapterId,
					pageNo: pageNo++,
					text,
					textSource: source,
					imageAssetId: null,
				});
			}
			// 兜底：没有任何故事元素时，至少产出一页（标记为连接词页，验收时会暴露主导性不足）
			if (pageNo === 1) {
				insertBookPage(db, { chapterId, pageNo: 1, text: params.title, textSource: "connector" });
				pageNo = 2;
			}

			markBookDone(db, runtime.bookId);
			runtime.chapterId = chapterId;
			runtime.stage = "S4";

			return textResult(`「${params.title}」第 ${chapterNo} 章做好啦，一共 ${pageNo - 1} 页，这是你自己讲出来的故事哦！`);
		},
	};
}
