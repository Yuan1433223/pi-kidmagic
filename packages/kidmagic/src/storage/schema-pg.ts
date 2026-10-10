/**
 * Kidmagic 作品库 PG 表结构（PostgreSQL DDL，P0-1 存储迁移）。
 *
 * 与 schema.ts（SQLite DDL）一一对应，差异：
 * - JSON 数组/对象字段（asset_clusters.asset_ids、assets.ner_entities）改用 JSONB。
 * - created_at / updated_at 用 BIGINT 存毫秒时间戳（与现有 Date.now() 代码兼容）。
 * - 主键 TEXT（uuidv7 字符串），索引同 SQLite 版。
 *
 * 表语义与 AGENTS.md §3.6 一致：story_elements.child_words / book_pages.text_source
 * 是"孩子主导性"验收依据；chapters.recap_summary 为续写前情。
 */
export const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ingest_items (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  book_id    TEXT NOT NULL,
  batch_no   INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'drawing',
  mime_type  TEXT NOT NULL,
  uri        TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'raw_child',
  width      INTEGER,
  height     INTEGER,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  kind         TEXT NOT NULL,
  mime_type    TEXT,
  uri          TEXT,
  ner_entities TEXT,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_clusters (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  cluster_type TEXT NOT NULL,
  label        TEXT NOT NULL,
  confirmed    INTEGER NOT NULL DEFAULT 0,
  asset_ids    TEXT NOT NULL DEFAULT '[]',
  appearance   TEXT NOT NULL DEFAULT '',
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  persona         TEXT NOT NULL DEFAULT 'A',
  stage           TEXT NOT NULL DEFAULT 'S0',
  status          TEXT NOT NULL DEFAULT 'active',
  current_book_id TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT,
  tool_name  TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS story_elements (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  book_id      TEXT,
  element_type TEXT NOT NULL,
  content      TEXT NOT NULL,
  child_words  TEXT NOT NULL DEFAULT '',
  order_idx    INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  appearance      TEXT NOT NULL DEFAULT '',
  personality     TEXT NOT NULL DEFAULT '',
  catchphrase     TEXT NOT NULL DEFAULT '',
  source_asset_id TEXT,
  created_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  cover_asset_id TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_characters (
  book_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'supporting',
  PRIMARY KEY (book_id, character_id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  chapter_no    INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL DEFAULT '',
  cover_asset_id TEXT,
  recap_summary TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_pages (
  id                  TEXT PRIMARY KEY,
  chapter_id          TEXT NOT NULL,
  page_no             INTEGER NOT NULL DEFAULT 1,
  text                TEXT NOT NULL DEFAULT '',
  text_source         TEXT NOT NULL DEFAULT 'child_raw',
  image_asset_id      TEXT,
  generated_image_uri TEXT,
  created_at          BIGINT NOT NULL
);

-- P0-3 账号：家长（手机号+密码）与孩子档案
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL DEFAULT '',
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS children (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  age        INTEGER,
  avatar     TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_session ON assets(session_id);
CREATE INDEX IF NOT EXISTS idx_ingest_session ON ingest_items(session_id);
CREATE INDEX IF NOT EXISTS idx_ingest_book_batch ON ingest_items(book_id, batch_no);
CREATE INDEX IF NOT EXISTS idx_clusters_session ON asset_clusters(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_elements_session ON story_elements(session_id);
CREATE INDEX IF NOT EXISTS idx_pages_chapter ON book_pages(chapter_id);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_children_user ON children(user_id);

-- 已存在的 books 表迁移补列（P0-3：作品归属家长/孩子档案；游客两条均为 NULL）
ALTER TABLE books ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS child_id TEXT;
CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);

-- 章节封面（章节封面：默认该章第一页图，可上传替换）
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS cover_asset_id TEXT;

-- P0-6 管理员：邀请码批次 + 码（迁移旧版 InviteStore，JSON 文件 → PG；book_id 关联激活后的作品）
CREATE TABLE IF NOT EXISTS invite_batches (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  count      INTEGER NOT NULL,
  base_url   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS invite_codes (
  code         TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL REFERENCES invite_batches(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'issued',
  user_name    TEXT NOT NULL DEFAULT '',
  book_id      TEXT,
  activated_at BIGINT,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_batch ON invite_codes(batch_id);

-- 统一图片资产表（uploads 落盘的每张图登记来源/用途/引用，孤儿可清理；kind=ingest/cover/generated）
CREATE TABLE IF NOT EXISTS image_assets (
  id          TEXT PRIMARY KEY,
  uri         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  source_uri  TEXT,
  ref_id      TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_assets_kind ON image_assets(kind);
CREATE INDEX IF NOT EXISTS idx_image_assets_ref ON image_assets(ref_id);
`;
