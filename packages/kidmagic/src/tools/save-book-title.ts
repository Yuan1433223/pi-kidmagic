import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { createBook, getBook, setBookTitle } from "../storage/repo.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({
	title: Type.String(),
});

type Params = Static<typeof parameters>;

/** 保存孩子起的书名（S4 生成前，书名进封面，增强拥有感）。 */
export function createSaveBookTitleTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "save_book_title",
		description: "和孩子一起为绘本定书名后调用：保存书名（最好用孩子自己想的名字）",
		label: "保存书名",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const { db, runtime } = deps;
			if (!runtime.bookId) {
				runtime.bookId = await createBook(db, { sessionId: runtime.sessionId, title: params.title });
			} else {
				// 书已存在（含续写场景）：书名由第一次定死，不再覆盖，仅当书尚无标题才用本次书名
				const book = await getBook(db, runtime.bookId);
				if (!book?.title) await setBookTitle(db, runtime.bookId, params.title);
			}
			return textResult(`书名就叫「${params.title}」！`);
		},
	};
}
