import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({
	emotion: Type.Union([
		Type.Literal("happy"),
		Type.Literal("curious"),
		Type.Literal("proud"),
	]),
	/** 魔法棒具象化提示（如"大树森林"），轻量动效，不触发图生图 */
	sceneHint: Type.Optional(Type.String()),
});

type Params = Static<typeof parameters>;

const EMOTION_TEXT: Record<Params["emotion"], string> = {
	happy: "太好啦，魔法棒一挥，你讲的画面变出来啦！",
	curious: "哇，接下来会发生什么有趣的事呢？",
	proud: "这是你自己想出来的故事，真了不起！",
};

/**
 * 魔法棒轻量动效反馈：表达"我们听懂你的意思了"。
 * P0 为轻量动效（返回前端特效指令），不落库、不调用图生图。
 */
export function createMagicRenderTool(_deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "magic_render",
		description:
			"孩子讲完一段后调用：挥魔法棒把他讲的画面轻轻变出来（轻量动效），让孩子感到被听懂、被肯定；emotion 为反馈情绪",
		label: "魔法棒具象化反馈",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const hint = params.sceneHint ? `（变出：${params.sceneHint}）` : "";
			return textResult(`${EMOTION_TEXT[params.emotion]}${hint}`);
		},
	};
}
