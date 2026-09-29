/**
 * Kidmagic - 儿童创造力故事机（基于 Pi 二开的独立产品包）
 *
 * 复用 Pi：pi-agent-core（Agent 循环/事件/钩子）、pi-ai（多模型/图片输入）、
 *          pi-session-backend-sqlite-node（会话持久化，P1 接入）。
 * 自建：引导状态机（S0-S4）、故事域工具、作品库（node:sqlite）、系统提示词、server。
 */

// 状态机与运行态
export * from "./agent/stages.ts";
export { buildSystemPrompt } from "./agent/prompts.ts";
export {
	createStoryAgent,
	type CreateStoryAgentOptions,
	type StoryAgentHandle,
} from "./agent/story-agent.ts";

// 工具
export { createKidmagicTools, KIDMAGIC_TOOL_NAMES } from "./tools/index.ts";

// 作品库
export { openDatabase, type DatabaseSync } from "./storage/db.ts";
export * as repo from "./storage/repo.ts";
export { SCHEMA_SQL } from "./storage/schema.ts";
