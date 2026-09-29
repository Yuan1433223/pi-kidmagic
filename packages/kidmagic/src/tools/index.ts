import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ToolDeps } from "./types.ts";
import { createIngestAssetsTool } from "./ingest-assets.ts";
import { createMagicRenderTool } from "./magic-render.ts";
import { createSaveStoryElementTool } from "./save-story-element.ts";
import { createBuildCharacterCardTool } from "./build-character-card.ts";
import { createCheckSkeletonTool } from "./check-skeleton.ts";
import { createSaveBookTitleTool } from "./save-book-title.ts";
import { createStartBookGenerationTool } from "./start-book-generation.ts";

/**
 * 创建 kidmagic 白名单工具集（agent 可调用），注入作品库与会话运行态。
 * 安全红线：beforeToolCall 钩子拦截一切非白名单工具（含 Pi 默认 bash 类）。
 * 异构工具数组，TDetails 统一用 unknown（避免 any）。
 */
export function createKidmagicTools(deps: ToolDeps): AgentTool<TSchema, unknown>[] {
	return [
		createIngestAssetsTool(deps),
		createMagicRenderTool(deps),
		createSaveStoryElementTool(deps),
		createBuildCharacterCardTool(deps),
		createCheckSkeletonTool(deps),
		createSaveBookTitleTool(deps),
		createStartBookGenerationTool(deps),
	];
}

/** 白名单工具名（beforeToolCall 据此放行） */
export const KIDMAGIC_TOOL_NAMES = [
	"ingest_assets",
	"magic_render",
	"save_story_element",
	"build_character_card",
	"check_skeleton",
	"save_book_title",
	"start_book_generation",
] as const;
