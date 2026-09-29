import { Agent, type AgentEvent, type FinishTurn, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { DatabaseSync } from "../storage/db.ts";
import { createSession, insertMessage, updateSessionStage } from "../storage/repo.ts";
import { createKidmagicTools, KIDMAGIC_TOOL_NAMES } from "../tools/index.ts";
import {
	createRuntime,
	MAX_GAP_ROUNDS,
	type Persona,
	type StoryRuntime,
} from "./stages.ts";
import { buildSystemPrompt } from "./prompts.ts";

/** 工具白名单（beforeToolCall 据此放行，其余一律拦截，含 Pi 默认 bash 类工具） */
const TOOL_WHITELIST: ReadonlySet<string> = new Set<string>(KIDMAGIC_TOOL_NAMES);

export interface CreateStoryAgentOptions<TApi extends string = string> {
	db: DatabaseSync;
	model: Model<TApi>;
	persona?: Persona;
	/** 复用已有会话 id；不传则新建会话并落库 */
	sessionId?: string;
	/** 流式函数，默认 compat 的 streamSimple；真实模型可传 models.streamSimple.bind(models) */
	streamFn?: StreamFn;
	/** 是否把对话消息落 session_messages（家长回放数据源），默认 true */
	persistMessages?: boolean;
}

export interface StoryAgentHandle {
	agent: Agent;
	runtime: StoryRuntime;
	sessionId: string;
}

/** 安全闸门：只放行 kidmagic 白名单工具 */
function makeBeforeToolCall() {
	return async (context: { toolCall: { name: string } }) => {
		if (!TOOL_WHITELIST.has(context.toolCall.name)) {
			return {
				block: true,
				reason: `工具 ${context.toolCall.name} 不在 kidmagic 白名单内，已禁止执行。`,
				terminate: true,
			};
		}
		return undefined;
	};
}

/**
 * 阶段机出口裁决（工具驱动，比解析 LLM 文本可靠）：
 * - start_book_generation：绘本生成 = 本次创作终点，end；
 * - check_skeleton：有缺口且未超 2 轮 → S3 continue（让 agent 追问）；否则 S4 continue（概括/起名/生成）；
 * - save_story_element：在倾听/追问阶段，continue 推动 agent 完成魔法反馈与缺口推理；
 * - 其余（面向孩子说话、等待输入）→ 返回 undefined，自然把控制权交还孩子。
 */
function makeFinishTurn(runtime: StoryRuntime, db: DatabaseSync): FinishTurn {
	return (turn) => {
		const names = turn.toolResults.map((r) => r.toolName);
		const has = (name: string): boolean => names.includes(name);

		if (has("start_book_generation")) {
			runtime.stage = "S4";
			updateSessionStage(db, runtime.sessionId, "S4", "completed", runtime.bookId ?? null);
			return { action: "end" };
		}

		if (has("check_skeleton")) {
			if (runtime.lastGaps.length > 0 && runtime.gapRoundCount < MAX_GAP_ROUNDS) {
				runtime.stage = "S3";
				runtime.gapRoundCount += 1;
				updateSessionStage(db, runtime.sessionId, "S3");
				return { action: "continue" };
			}
			runtime.stage = "S4";
			updateSessionStage(db, runtime.sessionId, "S4");
			return { action: "continue" };
		}

		if (
			has("save_story_element") &&
			(runtime.stage === "S0" || runtime.stage === "S1" || runtime.stage === "S3")
		) {
			if (runtime.stage === "S0") runtime.stage = "S1";
			updateSessionStage(db, runtime.sessionId, runtime.stage);
			return { action: "continue" };
		}

		if (runtime.stage === "S0" && has("ingest_assets")) {
			runtime.stage = "S1";
			updateSessionStage(db, runtime.sessionId, "S1");
		}

		// 三级降级（换问法→给选项→今天就到这）的自动推进留待真实语料校准；
		// P0 规则已写入系统提示词，runtime.fallbackLevel 字段预留。
		return undefined;
	};
}

/** 从消息中提取纯文本（用于落库，不依赖 any） */
function extractText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { type: string; text: string } =>
					typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
			)
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

/** 把 user/assistant/toolResult 消息落 session_messages（家长回放数据源） */
function makePersistListener(db: DatabaseSync, sessionId: string) {
	return (event: AgentEvent): void => {
		if (event.type !== "message_end") return;
		const message = event.message;
		if (message.role === "user" || message.role === "assistant") {
			const text = extractText(message as { content?: unknown });
			if (text.trim()) insertMessage(db, { sessionId, role: message.role, content: text });
		} else if (message.role === "toolResult") {
			const toolName = (message as { toolName?: string }).toolName;
			insertMessage(db, { sessionId, role: "tool", content: extractText(message as { content?: unknown }), toolName });
		}
	};
}

/** 装配一个 Kidmagic 故事 agent（系统提示词 + 白名单工具 + 阶段机 + 消息落库） */
export function createStoryAgent<TApi extends string = string>(
	options: CreateStoryAgentOptions<TApi>,
): StoryAgentHandle {
	const { db, model, persona = "A", persistMessages = true } = options;
	const sessionId = options.sessionId ?? createSession(db, persona);
	const runtime = createRuntime(sessionId, persona);
	const tools = createKidmagicTools({ db, runtime });

	const agent = new Agent({
		streamFn: options.streamFn ?? streamSimple,
		initialState: {
			systemPrompt: buildSystemPrompt(persona),
			model,
			thinkingLevel: "off",
			tools,
		},
		beforeToolCall: makeBeforeToolCall(),
		finishTurn: makeFinishTurn(runtime, db),
	});

	if (persistMessages) agent.subscribe(makePersistListener(db, sessionId));

	return { agent, runtime, sessionId };
}
