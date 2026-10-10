/**
 * 素材 → agent 上下文注入（修复链路断层：孩子传的画此前从未进入 agent 对话上下文）。
 *
 * 背景：上传的素材只被视觉理解抽成 label 存进 asset_clusters；agent 决定故事走向、
 * 写页面文字时完全看不到图片/素材信息，导致生成脱离孩子的真实创作。
 *
 * 本模块把已确认素材的视觉理解结果 + 角色卡外观拼成一段上下文，追加进 agent 的
 * 系统消息（messages[0].content），让 agent 在后续对话里"看得见"孩子传了什么。
 * 注入是幂等的（每次按当前素材重算追加），不阻塞、不改工具逻辑。
 */
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Db } from "../storage/db-pg.ts";

const TYPE_NAMES: Record<string, string> = { character: "角色", setting: "场景", prop: "物品" };

/** 按 session 查已识别的素材聚类（label 分组，含外观描述） */
async function listClustersBySession(db: Db, sessionId: string): Promise<{ cluster_type: string; label: string; appearance: string }[]> {
	return (await db.query(
		"SELECT cluster_type, label, appearance FROM asset_clusters WHERE session_id = $1 ORDER BY cluster_type, created_at",
		[sessionId],
	)) as unknown as { cluster_type: string; label: string; appearance: string }[];
}

/** 按书查已确定的角色卡（外观），用于主角形象一致性 */
async function listBookCharacterCards(
	db: Db,
	bookId: string,
): Promise<{ name: string; appearance: string }[]> {
	return (await db.query(
		`SELECT c.name, c.appearance FROM characters c
		 JOIN book_characters bc ON bc.character_id = c.id
		 WHERE bc.book_id = $1`,
		[bookId],
	)) as unknown as { name: string; appearance: string }[];
}

/**
 * 组装素材上下文文字（无素材返回空串）。
 * 内容：① 素材清单（孩子传的画，视觉理解认出了什么）② 角色卡外观（若书有关联角色）。
 */
export async function buildAssetContextText(db: Db, sessionId: string, bookId?: string): Promise<string> {
	const lines: string[] = [];

	const clusters = await listClustersBySession(db, sessionId);
	const byType: Record<string, string[]> = {};
	for (const c of clusters) {
		const app = c.appearance ? `（${c.appearance}）` : "";
		(byType[c.cluster_type] ??= []).push(`${c.label}${app}`);
	}
	const parts: string[] = [];
	for (const t of ["character", "setting", "prop"]) {
		if (byType[t]?.length) parts.push(`${TYPE_NAMES[t] ?? t}：${byType[t].join("、")}`);
	}
	if (parts.length) {
		lines.push(
			`孩子带来了素材，视觉理解从中认出了：${parts.join("；")}。这些是孩子真实的创作，故事的展开和画面都要围绕它们，不要偏离。`,
		);
	}

	if (bookId) {
		for (const ch of await listBookCharacterCards(db, bookId)) {
			if (ch.appearance) {
				lines.push(`已确定的角色「${ch.name}」的形象：${ch.appearance}。保持这个形象，不要改动外观。`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * 把素材上下文追加到 agent 系统消息（幂等：每次按当前素材重算追加）。
 * 无素材则不动。允许在素材确认后任意时刻调用。
 */
export async function injectAssetContext(
	agent: Agent,
	db: Db,
	sessionId: string,
	bookId?: string,
): Promise<void> {
	const text = await buildAssetContextText(db, sessionId, bookId);
	if (!text.trim()) {
		console.log(`[素材注入] 无可注入素材上下文（session=${sessionId.slice(0, 8)}）`);
		return;
	}
	const sys = agent.state.messages[0];
	if (sys?.role !== "system") {
		console.log(`[素材注入] 系统消息缺失或非 system，跳过（session=${sessionId.slice(0, 8)}）`);
		return;
	}
	const block = `\n\n# 孩子这次带来的素材\n${text}`;
	if (typeof sys.content === "string") {
		sys.content += block;
		console.log(`[素材注入] 已注入 system 文本（string 型，session=${sessionId.slice(0, 8)}）`);
	} else if (Array.isArray(sys.content)) {
		const tb = sys.content.find(
			(b): b is { type: "text"; text: string } =>
				b && typeof b === "object" && (b as { type?: unknown }).type === "text",
		);
		if (tb) {
			tb.text += block;
			console.log(`[素材注入] 已注入 system 文本块（session=${sessionId.slice(0, 8)}）`);
		} else {
			sys.content.push({ type: "text", text: block });
			console.log(`[素材注入] 已新增 system 文本块（session=${sessionId.slice(0, 8)}）`);
		}
	} else {
		console.log(`[素材注入] system content 类型未知（${typeof sys.content}），未注入（session=${sessionId.slice(0, 8)}）`);
	}
}
