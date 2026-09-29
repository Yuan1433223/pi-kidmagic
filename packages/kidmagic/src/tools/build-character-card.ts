import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { linkBookCharacter, upsertCharacter } from "../storage/repo.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({
	name: Type.String(),
	appearance: Type.String(),
	personality: Type.String(),
	catchphrase: Type.Optional(Type.String()),
});

type Params = Static<typeof parameters>;

/** 生成角色卡（主角从素材聚类/讲述中识别），存入跨故事共享的角色库。 */
export function createBuildCharacterCardTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "build_character_card",
		description:
			"当故事主角明确时调用：建立角色卡（名字/形象/性格/口头禅），存入角色库；主角信息要来自孩子的素材和讲述",
		label: "建立角色卡",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const { db, runtime } = deps;
			const characterId = upsertCharacter(db, {
				name: params.name,
				appearance: params.appearance,
				personality: params.personality,
				catchphrase: params.catchphrase,
			});
			if (runtime.bookId) linkBookCharacter(db, runtime.bookId, characterId, "protagonist");
			return textResult(`角色「${params.name}」登场啦！`);
		},
	};
}
