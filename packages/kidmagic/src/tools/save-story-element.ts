import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { insertStoryElement } from "../storage/repo.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({
	elementType: Type.Union([
		Type.Literal("character"),
		Type.Literal("setting"),
		Type.Literal("plotbeat"),
		Type.Literal("emotion"),
		Type.Literal("detail"),
		Type.Literal("resolution"),
	]),
	/** 整理后的故事内容（用于结构归档） */
	content: Type.String(),
	/** 孩子原话（主导性验收依据，尽量逐字记录，不要替孩子改写） */
	childWords: Type.String(),
	orderIdx: Type.Optional(Type.Integer()),
});

type Params = Static<typeof parameters>;

/** 把孩子本轮回答结构化存入故事元素库；childWords 必须是孩子原话。 */
export function createSaveStoryElementTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "save_story_element",
		description:
			"每听到孩子讲出故事内容就调用：结构化存为角色/场景/情节/情绪/细节/结尾；childWords 必须逐字记录孩子原话，禁止替他编造",
		label: "保存故事元素",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const { db, runtime } = deps;
			insertStoryElement(db, {
				sessionId: runtime.sessionId,
				bookId: runtime.bookId ?? null,
				elementType: params.elementType,
				content: params.content,
				childWords: params.childWords,
				orderIdx: params.orderIdx ?? 0,
			});
			return textResult(`我记下啦：${params.content}`);
		},
	};
}
