import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { Db } from "./db-pg.ts";

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

/** pg 的 BIGINT / COUNT 列返回 JS string，统一转 Number */
const toNum = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

// ── P0-3 账号：家长（users）与孩子档案（children） ──
export interface UserRow {
	id: string;
	phone: string;
	password_hash: string;
	nickname: string;
	created_at: number;
}
export interface ChildRow {
	id: string;
	user_id: string;
	name: string;
	age: number | null;
	avatar: string | null;
	created_at: number;
}

const normUser = (r: Record<string, unknown> | undefined): UserRow | undefined =>
	r ? { ...(r as unknown as UserRow), created_at: toNum(r.created_at) } : undefined;
const normChild = (r: Record<string, unknown> | undefined): ChildRow | undefined =>
	r ? { ...(r as unknown as ChildRow), created_at: toNum(r.created_at) } : undefined;

/** 注册家长（phone 唯一；passwordHash 由 auth.hashPassword 生成） */
export async function createUser(
	db: Db,
	p: { phone: string; passwordHash: string; nickname?: string },
): Promise<string> {
	const id = uuidv7();
	await db.query(
		"INSERT INTO users (id, phone, password_hash, nickname, created_at) VALUES ($1,$2,$3,$4,$5)",
		[id, p.phone, p.passwordHash, p.nickname ?? "", now()],
	);
	return id;
}
export async function getUserByPhone(db: Db, phone: string): Promise<UserRow | undefined> {
	return normUser((await db.query("SELECT * FROM users WHERE phone = $1 LIMIT 1", [phone]))[0] as Record<string, unknown> | undefined);
}
export async function getUserById(db: Db, id: string): Promise<UserRow | undefined> {
	return normUser((await db.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]))[0] as Record<string, unknown> | undefined);
}
/** 新增孩子档案（一个家长可多个孩子） */
export async function createChild(
	db: Db,
	p: { userId: string; name: string; age?: number | null; avatar?: string | null },
): Promise<string> {
	const id = uuidv7();
	await db.query(
		"INSERT INTO children (id, user_id, name, age, avatar, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
		[id, p.userId, p.name, p.age ?? null, p.avatar ?? null, now()],
	);
	return id;
}
export async function listChildrenByUser(db: Db, userId: string): Promise<ChildRow[]> {
	const rows = (await db.query("SELECT * FROM children WHERE user_id = $1 ORDER BY created_at", [userId])) as unknown as Record<string, unknown>[];
	return rows.map((r) => normChild(r)!);
}
export async function getChildById(db: Db, id: string): Promise<ChildRow | undefined> {
	return normChild((await db.query("SELECT * FROM children WHERE id = $1 LIMIT 1", [id]))[0] as Record<string, unknown> | undefined);
}

export async function createSession(db: Db, persona: "A" | "B" = "A"): Promise<string> {
	const id = uuidv7();
	const t = now();
	await db.query(
		"INSERT INTO sessions (id, persona, stage, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)",
		[id, persona, "S0", "active", t, t],
	);
	return id;
}

export async function updateSessionStage(
	db: Db,
	sessionId: string,
	stage: string,
	status?: string,
	currentBookId?: string | null,
): Promise<void> {
	await db.query(
		`UPDATE sessions SET stage = $1, status = COALESCE($2, status),
		 current_book_id = COALESCE($3, current_book_id), updated_at = $4 WHERE id = $5`,
		[stage, status ?? null, currentBookId ?? null, now(), sessionId],
	);
}

export async function insertAsset(
	db: Db,
	p: { sessionId: string; kind: string; mimeType?: string; uri?: string; nerEntities?: unknown },
): Promise<string> {
	const id = uuidv7();
	await db.query(
		"INSERT INTO assets (id, session_id, kind, mime_type, uri, ner_entities, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
		[id, p.sessionId, p.kind, p.mimeType ?? null, p.uri ?? null, p.nerEntities ? JSON.stringify(p.nerEntities) : null, now()],
	);
	return id;
}

export async function upsertCluster(
	db: Db,
	p: {
		sessionId: string;
		clusterType: string;
		label: string;
		assetIds: string[];
		confirmed?: boolean;
		appearance?: string;
	},
): Promise<string> {
	const id = uuidv7();
	await db.query(
		"INSERT INTO asset_clusters (id, session_id, cluster_type, label, confirmed, asset_ids, appearance, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
		[id, p.sessionId, p.clusterType, p.label, p.confirmed ? 1 : 0, JSON.stringify(p.assetIds), p.appearance ?? "", now()],
	);
	return id;
}

export async function confirmCluster(db: Db, clusterId: string): Promise<void> {
	await db.query("UPDATE asset_clusters SET confirmed = 1 WHERE id = $1", [clusterId]);
}

/** 按 (session, 类型, 标签) 找已有聚类组（半自动合并同一角色多图用） */
export async function findCluster(
	db: Db,
	p: { sessionId: string; clusterType: string; label: string },
): Promise<{ id: string; asset_ids: string; appearance: string } | undefined> {
	return (await db.query(
		"SELECT id, asset_ids, appearance FROM asset_clusters WHERE session_id = $1 AND cluster_type = $2 AND label = $3 LIMIT 1",
		[p.sessionId, p.clusterType, p.label],
	))[0] as { id: string; asset_ids: string; appearance: string } | undefined;
}

/** 往已有聚类组追加素材 id（去重） */
export async function appendClusterAssets(db: Db, clusterId: string, assetIds: string[]): Promise<void> {
	const row = (await db.query("SELECT asset_ids FROM asset_clusters WHERE id = $1", [clusterId]))[0] as
		| { asset_ids: string }
		| undefined;
	if (!row) return;
	let list: string[];
	try {
		list = JSON.parse(row.asset_ids) as string[];
	} catch {
		list = [];
	}
	const merged = [...new Set([...list, ...assetIds])];
	await db.query("UPDATE asset_clusters SET asset_ids = $1 WHERE id = $2", [JSON.stringify(merged), clusterId]);
}

export async function insertMessage(
	db: Db,
	p: { sessionId: string; role: string; content: unknown; toolName?: string },
): Promise<string> {
	const id = uuidv7();
	const content = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
	await db.query(
		"INSERT INTO session_messages (id, session_id, role, content, tool_name, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
		[id, p.sessionId, p.role, content, p.toolName ?? null, now()],
	);
	return id;
}

export async function insertStoryElement(
	db: Db,
	p: {
		sessionId: string;
		bookId?: string | null;
		elementType: string;
		content: string;
		childWords: string;
		orderIdx?: number;
	},
): Promise<string> {
	const id = uuidv7();
	await db.query(
		`INSERT INTO story_elements (id, session_id, book_id, element_type, content, child_words, order_idx, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		[id, p.sessionId, p.bookId ?? null, p.elementType, p.content, p.childWords, p.orderIdx ?? 0, now()],
	);
	return id;
}

/** 角色库：按 name 去重（同名即视为同一角色，更新描述），跨故事共享。 */
export async function upsertCharacter(
	db: Db,
	p: { name: string; appearance?: string; personality?: string; catchphrase?: string; sourceAssetId?: string },
): Promise<string> {
	const existing = (await db.query("SELECT id FROM characters WHERE name = $1", [p.name]))[0] as { id: string } | undefined;
	if (existing) {
		await db.query(
			"UPDATE characters SET appearance = $1, personality = $2, catchphrase = $3 WHERE id = $4",
			[p.appearance ?? "", p.personality ?? "", p.catchphrase ?? "", existing.id],
		);
		return existing.id;
	}
	const id = uuidv7();
	await db.query(
		`INSERT INTO characters (id, name, appearance, personality, catchphrase, source_asset_id, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		[id, p.name, p.appearance ?? "", p.personality ?? "", p.catchphrase ?? "", p.sourceAssetId ?? null, now()],
	);
	return id;
}

export async function getCharacterByName(db: Db, name: string): Promise<CharacterRow | undefined> {
	return (await db.query("SELECT * FROM characters WHERE name = $1", [name]))[0] as unknown as CharacterRow | undefined;
}

/** 全部角色卡（设备本地角色库，量小；画布详情数据源） */
export async function listAllCharacters(db: Db): Promise<CharacterRow[]> {
	return (await db.query("SELECT * FROM characters ORDER BY created_at DESC")) as unknown as CharacterRow[];
}

export async function createBook(
	db: Db,
	p: { sessionId: string; title?: string; coverAssetId?: string | null; userId?: string | null; childId?: string | null },
): Promise<string> {
	const id = uuidv7();
	const t = now();
	await db.query(
		"INSERT INTO books (id, session_id, title, cover_asset_id, user_id, child_id, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
		[id, p.sessionId, p.title ?? "", p.coverAssetId ?? null, p.userId ?? null, p.childId ?? null, "draft", t, t],
	);
	await db.query("UPDATE sessions SET current_book_id = $1, updated_at = $2 WHERE id = $3", [id, t, p.sessionId]);
	return id;
}

/** P0-3：把书归属到家长/孩子档案（游客为 null 表示未绑定；登录后建书时挂 owner） */
export async function setBookOwner(
	db: Db,
	bookId: string,
	owner: { userId?: string | null; childId?: string | null },
): Promise<void> {
	await db.query("UPDATE books SET user_id = $1, child_id = $2, updated_at = $3 WHERE id = $4", [
		owner.userId ?? null,
		owner.childId ?? null,
		now(),
		bookId,
	]);
}

export async function setBookTitle(db: Db, bookId: string, title: string): Promise<void> {
	await db.query("UPDATE books SET title = $1, updated_at = $2 WHERE id = $3", [title, now(), bookId]);
}

/** 删除一本书：级联删除其全部章节/页面/角色卡/上传素材/资产聚类/故事元素/会话记录（demo 一书一会话） */
/** 删除书的级联事务体（供 deleteBook / deleteUserCascade 复用；q 是事务执行器） */
async function deleteBookTx(q: (sql: string, params?: unknown[]) => Promise<unknown[]>, bookId: string): Promise<void> {
	const sess = (await q("SELECT session_id FROM books WHERE id = $1", [bookId]))[0] as { session_id: string } | undefined;
	await q("DELETE FROM book_pages WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id = $1)", [bookId]);
	await q("DELETE FROM chapters WHERE book_id = $1", [bookId]);
	await q("DELETE FROM book_characters WHERE book_id = $1", [bookId]);
	await q("DELETE FROM ingest_items WHERE book_id = $1", [bookId]);
	if (sess) {
		await q("DELETE FROM story_elements WHERE session_id = $1", [sess.session_id]);
		await q("DELETE FROM asset_clusters WHERE session_id = $1", [sess.session_id]);
		await q("DELETE FROM assets WHERE session_id = $1", [sess.session_id]);
		await q("DELETE FROM session_messages WHERE session_id = $1", [sess.session_id]);
		await q("DELETE FROM sessions WHERE id = $1", [sess.session_id]);
	}
	await q("DELETE FROM books WHERE id = $1", [bookId]);
}

export async function deleteBook(db: Db, bookId: string): Promise<void> {
	await db.tx(async (q) => deleteBookTx(q, bookId));
}

/** 书的全部上传素材（含待确认 pending），供资产弹窗「素材碎片」栏展示 */
export async function listBookMaterials(db: Db, bookId: string): Promise<{ uri: string; kind: string; status: string }[]> {
	return (await db.query("SELECT uri, kind, status FROM ingest_items WHERE book_id = $1 ORDER BY created_at", [bookId])) as unknown as { uri: string; kind: string; status: string }[];
}

export async function linkBookCharacter(
	db: Db,
	bookId: string,
	characterId: string,
	role: "protagonist" | "supporting" = "supporting",
): Promise<void> {
	await db.query(
		"INSERT INTO book_characters (book_id, character_id, role) VALUES ($1,$2,$3) ON CONFLICT (book_id, character_id) DO NOTHING",
		[bookId, characterId, role],
	);
}

export async function createChapter(
	db: Db,
	p: { bookId: string; chapterNo?: number; title?: string; recapSummary?: string },
): Promise<string> {
	const id = uuidv7();
	await db.query(
		"INSERT INTO chapters (id, book_id, chapter_no, title, recap_summary, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
		[id, p.bookId, p.chapterNo ?? 1, p.title ?? "", p.recapSummary ?? "", "draft", now()],
	);
	await db.query("UPDATE books SET status = 'generating', updated_at = $1 WHERE id = $2", [now(), p.bookId]);
	return id;
}

export async function insertBookPage(
	db: Db,
	p: {
		chapterId: string;
		pageNo?: number;
		text: string;
		textSource?: "child_raw" | "connector" | "ai";
		imageAssetId?: string | null;
		generatedImageUri?: string | null;
	},
): Promise<string> {
	const id = uuidv7();
	await db.query(
		`INSERT INTO book_pages (id, chapter_id, page_no, text, text_source, image_asset_id, generated_image_uri, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		[
			id,
			p.chapterId,
			p.pageNo ?? 1,
			p.text,
			p.textSource ?? "child_raw",
			p.imageAssetId ?? null,
			p.generatedImageUri ?? null,
			now(),
		],
	);
	return id;
}

/** 写回绘本页的图生图结果 URL */
export async function updateBookPageGeneratedImage(db: Db, pageId: string, uri: string): Promise<void> {
	await db.query("UPDATE book_pages SET generated_image_uri = $1 WHERE id = $2", [uri, pageId]);
}

export async function markBookDone(db: Db, bookId: string): Promise<void> {
	await db.query("UPDATE books SET status = 'done', updated_at = $1 WHERE id = $2", [now(), bookId]);
}

/** 绘本进入"配图中"状态（BullMQ 异步路径：文字页就绪、图生图在后台进行；前端据 status 控制轮询/完成感） */
export async function markBookGenerating(db: Db, bookId: string): Promise<void> {
	await db.query("UPDATE books SET status = 'generating', updated_at = $1 WHERE id = $2", [now(), bookId]);
}

export async function getBook(db: Db, bookId: string): Promise<BookRow | undefined> {
	return (await db.query("SELECT id, session_id, title, status FROM books WHERE id = $1", [bookId]))[0] as unknown as
		| BookRow
		| undefined;
}

/** 章节行（续写前情提要读取） */
export interface ChapterRow {
	id: string;
	book_id: string;
	chapter_no: number;
	title: string;
	cover_asset_id: string | null;
	recap_summary: string;
	status: string;
}

/** 书列表卡片（工作台首页用；含孩子归属，供 P0-6 家长端书架按孩子分组） */
export interface BookMetaRow {
	id: string;
	title: string;
	status: string;
	cover_asset_id: string | null;
	chapter_count: number;
	latest_chapter_no: number | null;
	updated_at: number;
	child_id: string | null;
	child_name: string | null;
}

/** 工作台「我的故事」列表：按最近更新倒序，附章节数/最新章号/封面；可按归属过滤（P0-3） */
export interface BookListFilter {
	userId?: string; // 只看某家长的书
	childId?: string; // 只看某孩子的书（通常与 userId 同传）
	guest?: boolean; // 只看未绑定 owner 的书（游客）
}
export async function listBooksWithMeta(db: Db, filter?: BookListFilter): Promise<BookMetaRow[]> {
	const where: string[] = [];
	const params: unknown[] = [];
	if (filter?.userId) { params.push(filter.userId); where.push(`b.user_id = $${params.length}`); }
	if (filter?.childId) { params.push(filter.childId); where.push(`b.child_id = $${params.length}`); }
	if (filter?.guest) { where.push(`b.user_id IS NULL`); }
	const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
	const rows = (await db.query(
		`SELECT b.id, b.title, b.status, b.cover_asset_id, b.updated_at, b.child_id, c.name AS child_name,
		        (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id)  AS chapter_count,
		        (SELECT MAX(c.chapter_no) FROM chapters c WHERE c.book_id = b.id) AS latest_chapter_no
		 FROM books b LEFT JOIN children c ON c.id = b.child_id${whereSql}
		 ORDER BY b.updated_at DESC`,
		params,
	)) as unknown as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as string,
		title: r.title as string,
		status: r.status as string,
		cover_asset_id: (r.cover_asset_id as string | null) ?? null,
		chapter_count: toNum(r.chapter_count),
		latest_chapter_no: r.latest_chapter_no === null ? null : toNum(r.latest_chapter_no),
		updated_at: toNum(r.updated_at),
		child_id: (r.child_id as string | null) ?? null,
		child_name: (r.child_name as string | null) ?? null,
	}));
}

/** 工作台书详情：一本书的所有章节（含前情提要） */
export async function listChaptersByBook(db: Db, bookId: string): Promise<ChapterRow[]> {
	return (await db.query(
		"SELECT id, book_id, chapter_no, title, cover_asset_id, recap_summary, status FROM chapters WHERE book_id = $1 ORDER BY chapter_no",
		[bookId],
	)) as unknown as ChapterRow[];
}

/** 按 id 读章节 */
export async function getChapter(db: Db, chapterId: string): Promise<ChapterRow | undefined> {
	return (await db.query(
		"SELECT id, book_id, chapter_no, title, cover_asset_id, recap_summary, status FROM chapters WHERE id = $1",
		[chapterId],
	))[0] as unknown as ChapterRow | undefined;
}

/** 取一本书的最新章节（续写定位"上一章"用） */
export async function getLatestChapter(db: Db, bookId: string): Promise<ChapterRow | undefined> {
	return (await db.query(
		"SELECT id, book_id, chapter_no, title, cover_asset_id, recap_summary, status FROM chapters WHERE book_id = $1 ORDER BY chapter_no DESC LIMIT 1",
		[bookId],
	))[0] as unknown as ChapterRow | undefined;
}

/** 写入章节前情提要摘要（P1 续写注入依据） */
export async function updateChapterRecap(db: Db, chapterId: string, summary: string): Promise<void> {
	await db.query("UPDATE chapters SET recap_summary = $1 WHERE id = $2", [summary, chapterId]);
}

/** 章节改名（P0-6） */
export async function updateChapterTitle(db: Db, chapterId: string, title: string): Promise<void> {
	await db.query("UPDATE chapters SET title = $1 WHERE id = $2", [title, chapterId]);
}

/** 章节封面（P0-6：封面默认该章第一页图，可上传替换，存 uploads uri） */
export async function updateChapterCover(db: Db, chapterId: string, coverUri: string): Promise<void> {
	await db.query("UPDATE chapters SET cover_asset_id = $1 WHERE id = $2", [coverUri, chapterId]);
}

/** 删除章节（事务级联删该章绘本页；章节删空不影响书） */
export async function deleteChapter(db: Db, chapterId: string): Promise<void> {
	await db.tx(async (q) => {
		await q("DELETE FROM book_pages WHERE chapter_id = $1", [chapterId]);
		await q("DELETE FROM chapters WHERE id = $1", [chapterId]);
	});
}

export async function listPages(db: Db, chapterId: string): Promise<BookPageRow[]> {
	return (await db.query(
		"SELECT id, chapter_id, page_no, text, text_source FROM book_pages WHERE chapter_id = $1 ORDER BY page_no",
		[chapterId],
	)) as unknown as BookPageRow[];
}

/** 绘本页（含图生图结果），工作台展示用 */
export interface ChapterPageImageRow {
	id: string;
	page_no: number;
	text: string;
	text_source: string;
	image_asset_id: string | null;
	generated_image_uri: string | null;
}

export async function listChapterPagesWithImages(db: Db, chapterId: string): Promise<ChapterPageImageRow[]> {
	return (await db.query(
		"SELECT id, page_no, text, text_source, image_asset_id, generated_image_uri FROM book_pages WHERE chapter_id = $1 ORDER BY page_no",
		[chapterId],
	)) as unknown as ChapterPageImageRow[];
}

/** 会话内已提取的角色/场景资产（工作台画布数据源） */
export interface SessionAssetRow {
	id: string;
	element_type: "character" | "setting";
	content: string;
}

export async function listSessionAssets(db: Db, sessionId: string): Promise<SessionAssetRow[]> {
	return (await db.query(
		"SELECT id, element_type, content FROM story_elements WHERE session_id = $1 AND element_type IN ('character','setting') ORDER BY COALESCE(order_idx, 0)",
		[sessionId],
	)) as unknown as SessionAssetRow[];
}

/** 按书聚合角色/场景资产：该书全部元素 + 首章会话早期（建书前 book_id 为空）的元素 */
export async function listBookAssets(db: Db, bookId: string, firstSessionId: string): Promise<SessionAssetRow[]> {
	return (await db.query(
		"SELECT id, element_type, content FROM story_elements WHERE (book_id = $1 OR session_id = $2) AND element_type IN ('character','setting') ORDER BY COALESCE(order_idx, 0)",
		[bookId, firstSessionId],
	)) as unknown as SessionAssetRow[];
}

export async function listStoryElements(db: Db, sessionId: string): Promise<StoryElementRow[]> {
	return (await db.query(
		"SELECT id, element_type, content, child_words, order_idx FROM story_elements WHERE session_id = $1 ORDER BY order_idx, created_at",
		[sessionId],
	)) as unknown as StoryElementRow[];
}

/**
 * 主导性验收：本章页面文字中 child_raw（孩子原话）占比。
 * P0 门槛：≥ 0.6（见 AGENTS.md §3.7）。
 */
export async function childRawRatio(db: Db, chapterId: string): Promise<{ childRaw: number; total: number; ratio: number }> {
	const rows = (await db.query("SELECT text_source FROM book_pages WHERE chapter_id = $1", [chapterId])) as { text_source: string }[];
	const total = rows.length;
	const childRaw = rows.filter((r) => r.text_source === "child_raw").length;
	return { childRaw, total, ratio: total === 0 ? 0 : childRaw / total };
}

/** 用户上传暂存行（ingest_items，P1 工作台素材上传） */
export interface IngestItemRow {
	id: string;
	session_id: string;
	book_id: string;
	batch_no: number;
	kind: string;
	mime_type: string;
	uri: string;
	role: string;
	width: number | null;
	height: number | null;
	status: string;
	created_at: number;
}

/** 取某书当前最大批次号 +1（无则 1） */
export async function nextIngestBatchNo(db: Db, bookId: string): Promise<number> {
	const row = (await db.query("SELECT COALESCE(MAX(batch_no), 0) AS n FROM ingest_items WHERE book_id = $1", [bookId]))[0] as { n: unknown };
	return toNum(row.n) + 1;
}

/** 插入一条用户上传暂存记录（role 默认 raw_child=孩子原图） */
export async function insertIngestItem(
	db: Db,
	p: {
		sessionId: string;
		bookId: string;
		batchNo: number;
		kind?: string;
		mimeType: string;
		uri: string;
		role?: string;
		width?: number | null;
		height?: number | null;
	},
): Promise<string> {
	const id = uuidv7();
	await db.query(
		`INSERT INTO ingest_items (id, session_id, book_id, batch_no, kind, mime_type, uri, role, width, height, status, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		[
			id,
			p.sessionId,
			p.bookId,
			p.batchNo,
			p.kind ?? "drawing",
			p.mimeType,
			p.uri,
			p.role ?? "raw_child",
			p.width ?? null,
			p.height ?? null,
			"pending",
			now(),
		],
	);
	return id;
}

/** 某批次上传记录（按顺序） */
export async function listIngestItemsByBatch(db: Db, bookId: string, batchNo: number): Promise<IngestItemRow[]> {
	const rows = (await db.query(
		"SELECT id, session_id, book_id, batch_no, kind, mime_type, uri, role, width, height, status, created_at FROM ingest_items WHERE book_id = $1 AND batch_no = $2 ORDER BY created_at",
		[bookId, batchNo],
	)) as unknown as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as string,
		session_id: r.session_id as string,
		book_id: r.book_id as string,
		batch_no: toNum(r.batch_no),
		kind: r.kind as string,
		mime_type: r.mime_type as string,
		uri: r.uri as string,
		role: r.role as string,
		width: r.width === null ? null : toNum(r.width),
		height: r.height === null ? null : toNum(r.height),
		status: r.status as string,
		created_at: toNum(r.created_at),
	}));
}

/** 确认一批上传（pending → confirmed，触发后续视觉理解） */
export async function confirmIngestBatch(db: Db, bookId: string, batchNo: number): Promise<void> {
	await db.query("UPDATE ingest_items SET status = 'confirmed' WHERE book_id = $1 AND batch_no = $2 AND status = 'pending'", [bookId, batchNo]);
}

/** 丢弃一批上传（pending → discarded） */
export async function discardIngestBatch(db: Db, bookId: string, batchNo: number): Promise<void> {
	await db.query("UPDATE ingest_items SET status = 'discarded' WHERE book_id = $1 AND batch_no = $2 AND status = 'pending'", [bookId, batchNo]);
}

// ── P0-6 管理员后台：概览与列表查询（迁移旧版 admin_api 的展示逻辑，去掉分镜/视频） ──

export interface AdminOverview {
	users: number;
	children: number;
	books: number;
	generating: number;
	done: number;
}
export async function adminOverview(db: Db): Promise<AdminOverview> {
	const row = (await db.query(
		`SELECT
		   (SELECT COUNT(*) FROM users) AS users,
		   (SELECT COUNT(*) FROM children) AS children,
		   (SELECT COUNT(*) FROM books) AS books,
		   (SELECT COUNT(*) FROM books WHERE status='generating') AS generating,
		   (SELECT COUNT(*) FROM books WHERE status='done') AS done`,
	))[0] as Record<string, unknown>;
	return {
		users: toNum(row.users),
		children: toNum(row.children),
		books: toNum(row.books),
		generating: toNum(row.generating),
		done: toNum(row.done),
	};
}

export interface AdminUserRow {
	id: string;
	phone: string;
	nickname: string;
	created_at: number;
	child_count: number;
	book_count: number;
}
export async function listAdminUsers(db: Db): Promise<AdminUserRow[]> {
	const rows = (await db.query(
		`SELECT u.id, u.phone, u.nickname, u.created_at,
		        (SELECT COUNT(*) FROM children c WHERE c.user_id = u.id) AS child_count,
		        (SELECT COUNT(*) FROM books b WHERE b.user_id = u.id)  AS book_count
		 FROM users u ORDER BY u.created_at DESC`,
	)) as unknown as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as string,
		phone: r.phone as string,
		nickname: r.nickname as string,
		created_at: toNum(r.created_at),
		child_count: toNum(r.child_count),
		book_count: toNum(r.book_count),
	}));
}

export interface AdminChildRow {
	id: string;
	user_id: string;
	user_phone: string;
	name: string;
	age: number | null;
	created_at: number;
	book_count: number;
}
export async function listAdminChildren(db: Db, userId?: string): Promise<AdminChildRow[]> {
	const where = userId ? " WHERE c.user_id = $1" : "";
	const params = userId ? [userId] : [];
	const rows = (await db.query(
		`SELECT c.id, c.user_id, c.name, c.age, c.created_at, u.phone AS user_phone,
		        (SELECT COUNT(*) FROM books b WHERE b.child_id = c.id) AS book_count
		 FROM children c LEFT JOIN users u ON u.id = c.user_id${where} ORDER BY c.created_at DESC`,
		params,
	)) as unknown as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as string,
		user_id: r.user_id as string,
		user_phone: r.user_phone as string,
		name: r.name as string,
		age: r.age === null ? null : toNum(r.age),
		created_at: toNum(r.created_at),
		book_count: toNum(r.book_count),
	}));
}

export interface AdminBookRow {
	id: string;
	title: string;
	status: string;
	user_phone: string | null;
	child_name: string | null;
	created_at: number;
	updated_at: number;
	chapter_count: number;
}
export async function listAdminBooks(db: Db, opts?: { userId?: string; childId?: string }): Promise<AdminBookRow[]> {
	const where: string[] = [];
	const params: unknown[] = [];
	if (opts?.userId) { params.push(opts.userId); where.push(`b.user_id = $${params.length}`); }
	if (opts?.childId) { params.push(opts.childId); where.push(`b.child_id = $${params.length}`); }
	const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
	const rows = (await db.query(
		`SELECT b.id, b.title, b.status, b.created_at, b.updated_at, u.phone AS user_phone, c.name AS child_name,
		        (SELECT COUNT(*) FROM chapters ch WHERE ch.book_id = b.id) AS chapter_count
		 FROM books b
		 LEFT JOIN users u ON u.id = b.user_id
		 LEFT JOIN children c ON c.id = b.child_id${whereSql}
		 ORDER BY b.updated_at DESC`,
		params,
	)) as unknown as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as string,
		title: r.title as string,
		status: r.status as string,
		user_phone: r.user_phone as string | null,
		child_name: r.child_name as string | null,
		created_at: toNum(r.created_at),
		updated_at: toNum(r.updated_at),
		chapter_count: toNum(r.chapter_count),
	}));
}

/** 级联删除一个家长：其名下所有书 + 孩子档案 + 用户本身（单事务） */
export async function deleteUserCascade(db: Db, userId: string): Promise<{ books: number; children: number }> {
	const bookIds = (await db.query("SELECT id FROM books WHERE user_id = $1", [userId])) as unknown as { id: string }[];
	const childIds = (await db.query("SELECT id FROM children WHERE user_id = $1", [userId])) as unknown as { id: string }[];
	await db.tx(async (q) => {
		for (const b of bookIds) await deleteBookTx(q, b.id);
		for (const c of childIds) await q("DELETE FROM children WHERE id = $1", [c.id]);
		await q("DELETE FROM users WHERE id = $1", [userId]);
	});
	return { books: bookIds.length, children: childIds.length };
}

// ── P0-6 管理员：邀请码（迁移旧版 InviteStore，去掉易混字符，存 PG） ──
const INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const INVITE_PREFIX = "KM";
const INVITE_RANDOM_LENGTH = 20;
const makeInviteCode = (): string =>
	INVITE_PREFIX + Array.from({ length: INVITE_RANDOM_LENGTH }, () => INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)]).join("");

export interface InviteBatchRow {
	id: string;
	name: string;
	count: number;
	base_url: string;
	note: string;
	created_at: number;
	issued: number;
	activated: number;
}
export interface InviteCodeRow {
	code: string;
	batch_id: string;
	status: string;
	user_name: string;
	book_id: string | null;
	activated_at: number | null;
	created_at: number;
}

export async function createInviteBatch(
	db: Db,
	p: { name?: string; count: number; baseUrl: string; note?: string },
): Promise<InviteBatchRow> {
	if (!p.count || p.count < 1 || p.count > 10000) throw new Error("单次生成数量需在 1 到 10000 之间");
	if (!p.baseUrl) throw new Error("缺少二维码入口域名（baseUrl）");
	const batchId = `batch_${uuidv7().slice(0, 12)}`;
	const created = now();
	await db.tx(async (q) => {
		await q("INSERT INTO invite_batches (id, name, count, base_url, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [
			batchId,
			(p.name || "").trim() || "未命名批次",
			p.count,
			p.baseUrl.replace(/\/+$/, ""),
			(p.note || "").trim(),
			created,
		]);
		const existing = (await q("SELECT code FROM invite_codes")) as unknown as { code: string }[];
		const set = new Set(existing.map((r) => r.code));
		for (let i = 0; i < p.count; i++) {
			let code = makeInviteCode();
			while (set.has(code)) code = makeInviteCode();
			set.add(code);
			await q("INSERT INTO invite_codes (code, batch_id, status, user_name, book_id, activated_at, created_at) VALUES ($1,$2,'issued','',NULL,NULL,$3)", [code, batchId, created]);
		}
	});
	return { id: batchId, name: (p.name || "").trim() || "未命名批次", count: p.count, base_url: p.baseUrl.replace(/\/+$/, ""), note: (p.note || "").trim(), created_at: created, issued: p.count, activated: 0 };
}

export async function listInviteBatches(db: Db): Promise<InviteBatchRow[]> {
	const rows = (await db.query(
		`SELECT b.id, b.name, b.count, b.base_url, b.note, b.created_at,
		        (SELECT COUNT(*) FROM invite_codes c WHERE c.batch_id = b.id) AS issued,
		        (SELECT COUNT(*) FROM invite_codes c WHERE c.batch_id = b.id AND c.status = 'activated') AS activated
		 FROM invite_batches b ORDER BY b.created_at DESC`,
	)) as unknown as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as string,
		name: r.name as string,
		count: toNum(r.count),
		base_url: r.base_url as string,
		note: r.note as string,
		created_at: toNum(r.created_at),
		issued: toNum(r.issued),
		activated: toNum(r.activated),
	}));
}

export async function listInviteCodes(db: Db, batchId?: string): Promise<InviteCodeRow[]> {
	const where = batchId ? " WHERE batch_id = $1" : "";
	const params = batchId ? [batchId] : [];
	const rows = (await db.query(
		`SELECT code, batch_id, status, user_name, book_id, activated_at, created_at FROM invite_codes${where} ORDER BY created_at`,
		params,
	)) as unknown as Record<string, unknown>[];
	return rows.map((r) => ({
		code: r.code as string,
		batch_id: r.batch_id as string,
		status: r.status as string,
		user_name: r.user_name as string,
		book_id: r.book_id as string | null,
		activated_at: r.activated_at === null ? null : toNum(r.activated_at),
		created_at: toNum(r.created_at),
	}));
}

export async function getInviteCode(db: Db, code: string): Promise<InviteCodeRow | undefined> {
	const r = (await db.query("SELECT code, batch_id, status, user_name, book_id, activated_at, created_at FROM invite_codes WHERE code = $1 LIMIT 1", [code]))[0] as Record<string, unknown> | undefined;
	return r
		? {
				code: r.code as string,
				batch_id: r.batch_id as string,
				status: r.status as string,
				user_name: r.user_name as string,
				book_id: r.book_id as string | null,
				activated_at: r.activated_at === null ? null : toNum(r.activated_at),
				created_at: toNum(r.created_at),
		  }
		: undefined;
}

export async function updateInviteCode(db: Db, code: string, p: { userName?: string; status?: string }): Promise<InviteCodeRow> {
	const cur = await getInviteCode(db, code);
	if (!cur) throw new Error("邀请码不存在");
	if (p.status !== undefined && !["issued", "activated", "disabled"].includes(p.status)) throw new Error("邀请码状态无效");
	const status = p.status ?? cur.status;
	await db.query("UPDATE invite_codes SET user_name = $1, status = $2 WHERE code = $3", [
		p.userName !== undefined ? p.userName.trim() : cur.user_name,
		status,
		code,
	]);
	return { ...cur, user_name: p.userName !== undefined ? p.userName.trim() : cur.user_name, status };
}

export async function deleteInviteCode(db: Db, code: string): Promise<void> {
	await db.query("DELETE FROM invite_codes WHERE code = $1", [code]);
}

export async function deleteInviteBatch(db: Db, batchId: string): Promise<void> {
	await db.query("DELETE FROM invite_batches WHERE id = $1", [batchId]);
}
