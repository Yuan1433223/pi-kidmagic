import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { listChaptersByBook } from "../storage/repo.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({});

type Params = Static<typeof parameters>;

/**
 * 世界状态查询工具（P3 对话侧连续）。
 *
 * 让 agent 在续写、或不确定前面已定过什么时，查询当前故事的世界状态：
 * - 已识别的角色素材 / 角色卡形象 / 孩子讲述过的角色描述；
 * - 场景；
 * - 本书全部章节的前情提要。
 * 目的：保持角色与情节连续——不重复问"它长什么样"、不新增相悖设定。
 * 数据源与 P1 图生图世界状态注入、素材→agent 上下文注入共用（story_elements /
 * asset_clusters / characters via book_characters / chapters.recap_summary）。
 */
export function createGetWorldStateTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "get_world_state",
		description:
			"查询当前故事的世界状态：已确定的角色（素材/角色卡/孩子讲述）、场景，以及前面章节的前情提要。续写或不确定前面定过什么时，先调用它再展开，避免重复问或新增相悖设定。",
		label: "查看世界状态",
		parameters,
		execute: async () => {
			const { db, runtime } = deps;
			const parts: string[] = [];

			// 1) 素材聚类：角色/场景 label + 外观
			const clusters = (await db.query(
				"SELECT cluster_type, label, appearance FROM asset_clusters WHERE session_id = $1 ORDER BY cluster_type, created_at",
				[runtime.sessionId],
			)) as unknown as { cluster_type: string; label: string; appearance: string }[];
			const chars: string[] = [];
			const settings: string[] = [];
			for (const c of clusters) {
				const app = c.appearance ? `（${c.appearance}）` : "";
				if (c.cluster_type === "character") chars.push(`${c.label}${app}`);
				else if (c.cluster_type === "setting") settings.push(`${c.label}${app}`);
			}

			// 2) 角色卡形象（书关联；build_character_card 可能没被调 → 回退用 story_elements 的角色描述）
			const cards = runtime.bookId
				? ((await db.query(
						`SELECT c.name, c.appearance FROM characters c JOIN book_characters bc ON bc.character_id = c.id WHERE bc.book_id = $1`,
						[runtime.bookId],
					)) as unknown as { name: string; appearance: string }[])
				: [];
			const storyChars = runtime.bookId
				? ((await db.query(
						"SELECT content FROM story_elements WHERE (book_id = $1 OR session_id = $2) AND element_type = 'character' ORDER BY order_idx, created_at",
						[runtime.bookId, runtime.sessionId],
					)) as unknown as { content: string }[])
				: ((await db.query(
						"SELECT content FROM story_elements WHERE session_id = $1 AND element_type = 'character' ORDER BY order_idx, created_at",
						[runtime.sessionId],
					)) as unknown as { content: string }[]);

			if (chars.length) parts.push(`已识别的角色素材：${chars.join("、")}`);
			for (const c of cards) {
				if (c.appearance) parts.push(`角色「${c.name}」形象：${c.appearance}`);
			}
			if (storyChars.length) parts.push(`孩子讲述过的角色：${storyChars.map((s) => s.content).join("；")}`);
			if (settings.length) parts.push(`场景：${settings.join("、")}`);

			// 3) 前情：本书全部章节 recap
			if (runtime.bookId) {
				const chs = await listChaptersByBook(db, runtime.bookId);
				if (chs.length) {
					const recap = chs.map((c) => `第${c.chapter_no}章「${c.title}」：${c.recap_summary}`).join("\n");
					parts.push(`前面章节：\n${recap}`);
				}
			}

			if (parts.length === 0) {
				return textResult("当前还没有确定的世界状态（角色/场景/前情），继续引导孩子讲述即可。");
			}
			return textResult(`当前世界状态：\n${parts.join("\n")}`);
		},
	};
}
