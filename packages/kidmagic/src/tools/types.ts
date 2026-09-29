import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { DatabaseSync } from "../storage/db.ts";
import type { StoryRuntime } from "../agent/stages.ts";

/** 工具执行依赖：作品库句柄 + 当前会话运行态（由 createKidmagicTools 注入） */
export interface ToolDeps {
	db: DatabaseSync;
	runtime: StoryRuntime;
}

/** 构造纯文本工具结果（content 供模型阅读，details 留空） */
export function textResult(text: string): AgentToolResult<undefined> {
	const content: TextContent[] = [{ type: "text", text }];
	return { content, details: undefined };
}

/** 构造带图工具结果（如素材识别/绘本生成返回图片） */
export function imageResult(text: string, base64: string, mimeType: string): AgentToolResult<undefined> {
	const content: (TextContent | ImageContent)[] = [
		{ type: "text", text },
		{ type: "image", data: base64, mimeType },
	];
	return { content, details: undefined };
}
