import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Queue } from "bullmq";
import type { Db } from "../storage/db-pg.ts";
import type { StoryRuntime } from "../agent/stages.ts";
import type { ChapterImageJobData } from "../jobs/image-jobs.ts";

/** 工具执行依赖：作品库句柄 + 当前会话运行态（由 createKidmagicTools 注入） */
export interface ToolDeps {
	db: Db;
	runtime: StoryRuntime;
	/**
	 * 章节配图队列（BullMQ）。缺省 / 入队失败时，start_book_generation
	 * 自动降级为同步图生图，保证绘本始终能出片。
	 */
	imageQueue?: Queue<ChapterImageJobData> | null;
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
