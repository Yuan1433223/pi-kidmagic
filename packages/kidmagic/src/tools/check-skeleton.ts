import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { SkeletonGap } from "../agent/stages.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({
	gaps: Type.Array(
		Type.Union([
			Type.Literal("character"),
			Type.Literal("setting"),
			Type.Literal("conflict"),
			Type.Literal("resolution"),
		]),
	),
});

type Params = Static<typeof parameters>;

const GAP_LABEL: Record<SkeletonGap, string> = {
	character: "主角是谁",
	setting: "故事发生在哪里",
	conflict: "遇到了什么事",
	resolution: "最后怎么样了",
};

/**
 * 后台推理故事大框架缺口，写入运行态 lastGaps（finishTurn 据此裁决是否追问）。
 * 大框架完整优先于细节发散。
 */
export function createCheckSkeletonTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "check_skeleton",
		description:
			"孩子讲完一大段后调用：检查故事大框架是否缺 主角/场景/冲突/结尾；只报告真正缺失、会让故事讲不下去的部分，不要为小细节调用",
		label: "故事框架缺口推理",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const gaps = params.gaps as SkeletonGap[];
			deps.runtime.lastGaps = gaps;
			if (gaps.length === 0) return textResult("故事大框架已经完整，可以帮孩子把故事整理成绘本了。");
			return textResult(`还需要补全：${gaps.map((g) => GAP_LABEL[g]).join("、")}`);
		},
	};
}
