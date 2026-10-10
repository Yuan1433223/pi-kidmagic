/**
 * Kidmagic P0 数据库表结构（SQLite DDL）。
 *
 * 设计要点见 AGENTS.md §3.6：
 * - 作品库自建表（与 Pi 会话后端的表相互独立，可同库不同前缀）。
 * - characters 跨故事共享，book_characters 做多对多（承载"孩子长期 IP"）。
 * - story_elements.child_words / book_pages.text_source 是"孩子主导性"验收依据。
 * - chapters.recap_summary 为 P1 章节续写预留（前情提要摘要）。
 *
 * P0 共 10 张表 + P1 ingest_items（用户上传暂存表，解耦原始输入与正式素材库）；
 * parent_summaries（家长报告）属 P2，暂不建。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ingest_items (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  book_id    TEXT NOT NULL,
  batch_no   INTEGER NOT NULL,              -- 上传批次（每批上限约 10 张，可多批）
  kind       TEXT NOT NULL DEFAULT 'drawing', -- drawing | photo | other
  mime_type  TEXT NOT NULL,
  uri        TEXT NOT NULL,                 -- 本地存储相对路径，如 uploads/<id>.png
  role       TEXT NOT NULL DEFAULT 'raw_child', -- 统一图片角色：raw_child|cover_original|ref_character|gen_page
  width      INTEGER,
  height     INTEGER,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending|processing|confirmed|discarded
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  kind         TEXT NOT NULL,              -- drawing | photo | other
  mime_type    TEXT,
  uri          TEXT,                       -- 本地路径或 data URI（demo）
  ner_entities TEXT,                       -- JSON：NER 识别出的实体
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_clusters (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  cluster_type TEXT NOT NULL,              -- character | setting | prop
  label        TEXT NOT NULL,              -- 组名，如"小兔子"
  confirmed    INTEGER NOT NULL DEFAULT 0, -- 半自动：孩子确认后才为 1
  asset_ids    TEXT NOT NULL,              -- JSON 数组
  appearance   TEXT NOT NULL DEFAULT '',   -- 视觉理解的外观描述（角色/场景特征，agent 与图生图用它，不再追问外观）
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  persona         TEXT NOT NULL DEFAULT 'A',  -- A | B
  stage           TEXT NOT NULL DEFAULT 'S0', -- S0..S4
  status          TEXT NOT NULL DEFAULT 'active', -- active | paused | completed
  current_book_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,                -- user | assistant | tool | system
  content    TEXT,                         -- JSON 文本/内容块
  tool_name  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS story_elements (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  book_id      TEXT,
  element_type TEXT NOT NULL,              -- character | setting | plotbeat | emotion | detail | resolution
  content      TEXT NOT NULL,              -- 整理后的内容
  child_words  TEXT NOT NULL DEFAULT '',   -- 孩子原话（主导性验收依据）
  order_idx    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  appearance       TEXT NOT NULL DEFAULT '',
  personality      TEXT NOT NULL DEFAULT '',
  catchphrase      TEXT NOT NULL DEFAULT '',
  source_asset_id  TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  cover_asset_id TEXT,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | generating | done
  user_id        TEXT,                  -- P0-3 归属家长（游客为 NULL）
  child_id       TEXT,                  -- P0-3 归属孩子档案（游客为 NULL）
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_characters (
  book_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'supporting', -- protagonist | supporting
  PRIMARY KEY (book_id, character_id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  chapter_no    INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL DEFAULT '',
  recap_summary TEXT NOT NULL DEFAULT '',  -- 前情提要摘要（P1 续写注入）
  status        TEXT NOT NULL DEFAULT 'draft',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_pages (
  id                  TEXT PRIMARY KEY,
  chapter_id          TEXT NOT NULL,
  page_no             INTEGER NOT NULL DEFAULT 1,
  text                TEXT NOT NULL DEFAULT '',
  text_source         TEXT NOT NULL DEFAULT 'child_raw', -- child_raw | connector | ai
  image_asset_id      TEXT,                  -- 原画（孩子素材）
  generated_image_uri TEXT,                  -- 图生图结果（P1）
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_session ON assets(session_id);
CREATE INDEX IF NOT EXISTS idx_ingest_session ON ingest_items(session_id);
CREATE INDEX IF NOT EXISTS idx_ingest_book_batch ON ingest_items(book_id, batch_no);
CREATE INDEX IF NOT EXISTS idx_clusters_session ON asset_clusters(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_elements_session ON story_elements(session_id);
CREATE INDEX IF NOT EXISTS idx_pages_chapter ON book_pages(chapter_id);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);

-- P0-3 账号：家长（手机号+密码）与孩子档案
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS children (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  age        INTEGER,
  avatar     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_children_user ON children(user_id);
`;
