import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { DatabaseSync } from "./db.ts";

/** 行类型（只声明 demo/验收会读到的字段） */
export interface BookRow {
	id: string;
	session_id: string;
	title: string;
	status: string;
}
export interface BookPageRow {
	id: string;
	chapter_id: string;
	page_no: number;
	text: string;
	text_source: string;
}
export interface StoryElementRow {
	id: string;
	element_type: string;
	content: string;
	child_words: string;
	order_idx: number;
}
export interface CharacterRow {
	id: string;
	name: string;
	appearance: string;
	personality: string;
	catchphrase: string;
}

const now = (): number => Date.now();

export function createSession(db: DatabaseSync, persona: "A" | "B" = "A"): string {
	const id = uuidv7();
	const t = now();
	db.prepare(
		"INSERT INTO sessions (id, persona, stage, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
	).run(id, persona, "S0", "active", t, t);
	return id;
}

export function updateSessionStage(
	db: DatabaseSync,
	sessionId: string,
	stage: string,
	status?: string,
	currentBookId?: string | null,
): void {
	db.prepare(
		`UPDATE sessions SET stage = ?, status = COALESCE(?, status),
		 current_book_id = COALESCE(?, current_book_id), updated_at = ? WHERE id = ?`,
	).run(stage, status ?? null, currentBookId ?? null, now(), sessionId);
}

export function insertAsset(
	db: DatabaseSync,
	p: { sessionId: string; kind: string; mimeType?: string; uri?: string; nerEntities?: unknown },
): string {
	const id = uuidv7();
	db.prepare(
		"INSERT INTO assets (id, session_id, kind, mime_type, uri, ner_entities, created_at) VALUES (?,?,?,?,?,?,?)",
	).run(id, p.sessionId, p.kind, p.mimeType ?? null, p.uri ?? null, p.nerEntities ? JSON.stringify(p.nerEntities) : null, now());
	return id;
}

export function upsertCluster(
	db: DatabaseSync,
	p: { sessionId: string; clusterType: string; label: string; assetIds: string[]; confirmed?: boolean },
): string {
	const id = uuidv7();
	db.prepare(
		"INSERT INTO asset_clusters (id, session_id, cluster_type, label, confirmed, asset_ids, created_at) VALUES (?,?,?,?,?,?,?)",
	).run(id, p.sessionId, p.clusterType, p.label, p.confirmed ? 1 : 0, JSON.stringify(p.assetIds), now());
	return id;
}

export function confirmCluster(db: DatabaseSync, clusterId: string): void {
	db.prepare("UPDATE asset_clusters SET confirmed = 1 WHERE id = ?").run(clusterId);
}

export function insertMessage(
	db: DatabaseSync,
	p: { sessionId: string; role: string; content: unknown; toolName?: string },
): string {
	const id = uuidv7();
	const content = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
	db.prepare(
		"INSERT INTO session_messages (id, session_id, role, content, tool_name, created_at) VALUES (?,?,?,?,?,?)",
	).run(id, p.sessionId, p.role, content, p.toolName ?? null, now());
	return id;
}

export function insertStoryElement(
	db: DatabaseSync,
	p: {
		sessionId: string;
		bookId?: string | null;
		elementType: string;
		content: string;
		childWords: string;
		orderIdx?: number;
	},
): string {
	const id = uuidv7();
	db.prepare(
		`INSERT INTO story_elements (id, session_id, book_id, element_type, content, child_words, order_idx, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
	).run(id, p.sessionId, p.bookId ?? null, p.elementType, p.content, p.childWords, p.orderIdx ?? 0, now());
	return id;
}

/** 角色库：按 name 去重（同名即视为同一角色，更新描述），跨故事共享。 */
export function upsertCharacter(
	db: DatabaseSync,
	p: { name: string; appearance?: string; personality?: string; catchphrase?: string; sourceAssetId?: string },
): string {
	const existing = db
		.prepare("SELECT id FROM characters WHERE name = ?")
		.get(p.name) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			"UPDATE characters SET appearance = ?, personality = ?, catchphrase = ? WHERE id = ?",
		).run(p.appearance ?? "", p.personality ?? "", p.catchphrase ?? "", existing.id);
		return existing.id;
	}
	const id = uuidv7();
	db.prepare(
		`INSERT INTO characters (id, name, appearance, personality, catchphrase, source_asset_id, created_at)
		 VALUES (?,?,?,?,?,?,?)`,
	).run(id, p.name, p.appearance ?? "", p.personality ?? "", p.catchphrase ?? "", p.sourceAssetId ?? null, now());
	return id;
}

export function getCharacterByName(db: DatabaseSync, name: string): CharacterRow | undefined {
	return db.prepare("SELECT * FROM characters WHERE name = ?").get(name) as CharacterRow | undefined;
}

export function createBook(
	db: DatabaseSync,
	p: { sessionId: string; title?: string; coverAssetId?: string | null },
): string {
	const id = uuidv7();
	const t = now();
	db.prepare(
		"INSERT INTO books (id, session_id, title, cover_asset_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
	).run(id, p.sessionId, p.title ?? "", p.coverAssetId ?? null, "draft", t, t);
	db.prepare("UPDATE sessions SET current_book_id = ?, updated_at = ? WHERE id = ?").run(id, t, p.sessionId);
	return id;
}

export function setBookTitle(db: DatabaseSync, bookId: string, title: string): void {
	db.prepare("UPDATE books SET title = ?, updated_at = ? WHERE id = ?").run(title, now(), bookId);
}

export function linkBookCharacter(
	db: DatabaseSync,
	bookId: string,
	characterId: string,
	role: "protagonist" | "supporting" = "supporting",
): void {
	db.prepare(
		"INSERT OR IGNORE INTO book_characters (book_id, character_id, role) VALUES (?,?,?)",
	).run(bookId, characterId, role);
}

export function createChapter(
	db: DatabaseSync,
	p: { bookId: string; chapterNo?: number; title?: string; recapSummary?: string },
): string {
	const id = uuidv7();
	db.prepare(
		"INSERT INTO chapters (id, book_id, chapter_no, title, recap_summary, status, created_at) VALUES (?,?,?,?,?,?,?)",
	).run(id, p.bookId, p.chapterNo ?? 1, p.title ?? "", p.recapSummary ?? "", "draft", now());
	db.prepare("UPDATE books SET status = 'generating', updated_at = ? WHERE id = ?").run(now(), p.bookId);
	return id;
}

export function insertBookPage(
	db: DatabaseSync,
	p: {
		chapterId: string;
		pageNo?: number;
		text: string;
		textSource?: "child_raw" | "connector" | "ai";
		imageAssetId?: string | null;
		generatedImageUri?: string | null;
	},
): string {
	const id = uuidv7();
	db.prepare(
		`INSERT INTO book_pages (id, chapter_id, page_no, text, text_source, image_asset_id, generated_image_uri, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
	).run(
		id,
		p.chapterId,
		p.pageNo ?? 1,
		p.text,
		p.textSource ?? "child_raw",
		p.imageAssetId ?? null,
		p.generatedImageUri ?? null,
		now(),
	);
	return id;
}

export function markBookDone(db: DatabaseSync, bookId: string): void {
	db.prepare("UPDATE books SET status = 'done', updated_at = ? WHERE id = ?").run(now(), bookId);
}

export function getBook(db: DatabaseSync, bookId: string): BookRow | undefined {
	return db.prepare("SELECT id, session_id, title, status FROM books WHERE id = ?").get(bookId) as
		| BookRow
		| undefined;
}

export function listPages(db: DatabaseSync, chapterId: string): BookPageRow[] {
	return db
		.prepare("SELECT id, chapter_id, page_no, text, text_source FROM book_pages WHERE chapter_id = ? ORDER BY page_no")
		.all(chapterId) as unknown as BookPageRow[];
}

export function listStoryElements(db: DatabaseSync, sessionId: string): StoryElementRow[] {
	return db
		.prepare(
			"SELECT id, element_type, content, child_words, order_idx FROM story_elements WHERE session_id = ? ORDER BY order_idx, created_at",
		)
		.all(sessionId) as unknown as StoryElementRow[];
}

/**
 * 主导性验收：本章页面文字中 child_raw（孩子原话）占比。
 * P0 门槛：≥ 0.6（见 AGENTS.md §3.7）。
 */
export function childRawRatio(db: DatabaseSync, chapterId: string): { childRaw: number; total: number; ratio: number } {
	const rows = db
		.prepare("SELECT text_source FROM book_pages WHERE chapter_id = ?")
		.all(chapterId) as { text_source: string }[];
	const total = rows.length;
	const childRaw = rows.filter((r) => r.text_source === "child_raw").length;
	return { childRaw, total, ratio: total === 0 ? 0 : childRaw / total };
}
