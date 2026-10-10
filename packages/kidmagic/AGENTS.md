# Kidmagic 开发说明（中文）

> 面向 **4–8 岁孩子** 的 AI 故事机：孩子画素材 + 口头讲故事 → AI 组织成章节绘本。
> 基于 [earendil-works/pi](https://github.com/earendil-works/pi)（MIT，Node/TS monorepo）二开。
> 上游 Pi 包（agent-core / ai 等）当作黑盒，**只走顶层公开导出，不 import 其 `src` 内路径**。

## 产品红线（最重要）

- **孩子主导性 ≥ 60%**：绘本每页文字优先用孩子原话（`text_source='child_raw'`），AI 只允许加连接词，**禁止新增情节**。
- 验收依据：`book_pages.text_source` / `story_elements.child_words` 是主导性判定来源，`childRawRatio`（repo.ts）反映占比。

## 技术栈与目录（工程地图）

自开发包：`packages/kidmagic`（独立 workspace）。关键源码职责：

| 路径 | 职责 |
|---|---|
| `src/agent/stages.ts` | S0–S4 阶段机 + 运行态 `StoryRuntime`（`stage/persona/fallbackLevel/gapRoundCount/lastGaps/pendingAssetIds/bookId/chapterId/continuationChapterNo`） |
| `src/agent/prompts.ts` | 人设 A/B 系统提示词 + 续写前缀 `buildContinuationPrefix` |
| `src/agent/story-agent.ts` | `createStoryAgent` 装配：白名单闸门 / `finishTurn` 阶段裁决 / 消息落库 / 素材注入 |
| `src/agent/summary.ts` | 前情提要摘要 `buildRecapSummary`（确定性拼接，续写注入） |
| `src/agent/image-prompt.ts` | **P0-5 一致性**：结构化角色/场景卡（`WorldCards`）+ 每帧自包含 prompt（`STYLE_PREFIX`/`RATIO_SUFFIX`） |
| `src/agent/consistency.ts` | **P0-5 schema 校验**：`validateWorldCards` / `validatePagePromptSelfContained` / `validateChapterPage` |
| `src/agent/asset-context.ts` | 素材→agent 上下文注入（build/inject，P3） |
| `src/agent/qwen-dedicated.ts` | 百炼专属实例 provider（id `qwen-dedicated`） |
| `src/agent/reference-asset.ts` | 主角参考图（孩子原画 data URI，P2） |
| `src/tools/*` | 白名单 9 工具：`ingest_assets` / `analyze_ingest_batch` / `magic_render` / `save_story_element` / `build_character_card` / `check_skeleton` / `save_book_title` / `start_book_generation` / `get_world_state`；`paginate.ts`（分页归并/句读兜底）、`world-state.ts` |
| `src/vision/*` | `visual-understand.ts`（图片→实体）+ `ingest-cluster.ts`（素材理解聚类，工具与 server 共用） |
| `src/image/dashscope-image.ts` | 通义万相图生图封装（同步/异步、失败降级、退避） |
| `src/jobs/image-jobs.ts` | 章节配图核心 `generateChapterImages`（worker/同步共用）+ **`buildWorldCards` 重建角色/场景卡 + `validateChapterPage` 校验** |
| `src/jobs/queue.ts` | BullMQ Queue/Worker 工厂（Redis，队列名 `kidmagic-chapter-images`） |
| `src/voice/tencent-asr.ts` | 腾讯云一句话识别（手写 TC3-HMAC 签名；**已通**） |
| `src/voice/volc-tts.ts` | 火山单流 SSE TTS（**尚未调通**：`55000000 resource ID mismatched`，待换可用音色） |
| `src/auth.ts` | P0-3 账号：scrypt 密码哈希 + HMAC-SHA256 JWT（零第三方） |
| `src/storage/db-pg.ts` / `schema-pg.ts` / `repo.ts` | **PostgreSQL** 作品库：15 张表 + 40+ 数据访问函数（`$n` 占位、toNum、tx 级联） |
| `src/storage/db.ts` / `schema.ts` | SQLite（`sqliteDbAdapter` 供离线测试/脚本） |
| `src/server.ts` | node:http 工作台服务端（JSON API + 静态页，PORT=8787） |
| `public/index.html` | H5 工作台前端（单文件内联 CSS/JS）：首页书架/起名/书详情/画室/对话/翻页回放/完成感/画布/资产弹窗 + P0-6 魔法装饰层 |
| `public/admin.html` | P0-6 管理员后台页 |
| `public/manifest.webmanifest` / `icon.svg` | PWA 静态资产 |
| `scripts/*` | `demo-script.ts` / `demo-continuation.ts` / `smoke-image.ts` |
| `test/*` | vitest 离线测试（faux provider，**28 用例**） |
| `deploy/*` | 云上部署：Dockerfile / docker-compose.yml / nginx.conf.example / .env.production.example |

## 缓存与队列规则（P0-2 BullMQ）

- 队列名 `kidmagic-chapter-images`；Redis 本地用 **Memurai**（`localhost:6379`，无密码），`REDIS_HOST/PORT` 可覆盖（云上 compose 注入）。
- **job data 只存 `{bookId, chapterId, sessionId, title}`（id+文本），绝不含 apiKey 与图片二进制**；角色/场景卡由 worker 内 `buildWorldCards` 从库重建，参考图 `resolveReferenceImage` 从库重建。
- 入队失败 / Redis 不可用 → 调用方（`start_book_generation`）捕获并**降级同步图生图**；server 永不因队列不可用而崩。
- 图生图每页串行 + 三层退避（429 命中 2500×attempt ms，否则 1200ms）。

## 数据库（PostgreSQL，15 张表）

`src/storage/schema-pg.ts` 为权威 DDL，`schema.ts`（SQLite）一一对应。核心关系：

```
users ──< children ──< books ──< chapters ──< book_pages
characters ──(book_characters)── books          (children.user_id ON DELETE CASCADE)
sessions ──< story_elements
sessions ──< assets ──< asset_clusters
books ──< ingest_items（上传批次）
sessions ──< session_messages
invite_batches ──< invite_codes（P0-6 管理员）
```

- 表：`ingest_items / assets / asset_clusters / sessions / session_messages / story_elements / characters / books / book_characters / chapters / book_pages / users / children / invite_batches / invite_codes`。
- `books` 有 `user_id/child_id` 归属列（游客两条均 NULL，保留免登录体验）。

## 代码约定

- erasable TS：无 `enum`/`namespace`，字面量联合类型；import 放顶层；外部依赖精确锁版本。
- 工具参数用 TypeBox；工具需列入 `KIDMAGIC_TOOL_NAMES` 白名单，非白名单一律被 `beforeToolCall` 拦截。
- 改码后必跑：`npm run check`（零 error）+ `npm run test`（离线全绿，28/28）。
- 新业务在后端终端输出**最简易中文 log**（数据流周转复盘用），例：`[素材注入] … / [对话] 阶段=S4 …`。

## 常用命令

```bash
# 仓库根 workspace 形式
npm run check --workspace=@earendil-works/pi-kidmagic
npm run test  --workspace=@earendil-works/pi-kidmagic
npm run demo  --workspace=@earendil-works/pi-kidmagic              # 单章真机 demo（会计费）
npm run demo:continuation --workspace=@earendil-works/pi-kidmagic # 章节续写真机 demo
npm run smoke:image --workspace=@earendil-works/pi-kidmagic       # 图生图真机冒烟
# 工作台（在 packages/kidmagic 内执行）
cd packages/kidmagic && npm run server   # http://localhost:8787
```

- 真机需 `.env`（见 `packages/kidmagic/.env.example`），key 已 gitignore。
- Node ≥ 22.19（`node:sqlite` 实验警告；22.11 会报 `node:sqlite`，切 ≥ 22.13，推荐 22.23.x）。
- **存储**：PostgreSQL 18+（`DATABASE_URL`，云上 docker compose）。**队列**：Redis（本地 Memurai，BullMQ 需 ≥6.2 语义，旧 tporadowski/redis 5.0 不满足）。

## qwen / 百炼接入

- 专属实例端点 `https://llm-<id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，key `DASHSCOPE_API_KEY`。
- provider 选择：专属实例 > 公共套餐 `qwen-token-plan-cn` > OpenRouter。
- `qwen3.8-max`/`qwen3.7-plus` **原生支持视觉理解**（图片输入）。
- 图生图走百炼**通义万相 qwen-image-3.0**（与 qwen 同 key；端点=chatBase 去 `/compatible-mode/v1` 拼 `/api/v1/services/aigc/multimodal-generation/generation`，`{prompt_extend:true, size:"1024*1024"}`）。
- 语音 ASR/TTS 是需单独接入的服务：ASR 用腾讯云一句话识别（儿童口音友好，已通）；TTS 火山（待换可用音色）。

## 当前进度

- **P0 已完成**：单次完整流程闭环（素材→讲故事→补缺→概括→生成第一章），真机主导性 100%。
- **P1-B / P1-A 已完成**：章节续写闭环；工作台 server + H5（首页/起名/书详情+回看/画室/打字机对话/完成感）+ 视觉理解聚类 + 图生图接入 + 画布「生长」背景 + 资产总览弹窗 + 书列表增删改。
- **P0-1 已完成**：存储 → PostgreSQL（repo 全异步、15 表、级联删书；SQLite 适配保留离线测试）。
- **P0-2 已完成**：BullMQ 图生图异步化（配图核心 `image-jobs.ts`，worker/同步共用，job data 不含敏感信息，Redis 降级同步）。
- **P0-3 已完成**：账号体系（家长手机号+密码 + 孩子档案 + JWT），游客免登录保留，**登录后书列表按 user/child 归属过滤**（`listBooksWithMeta` 带 `child_id/child_name`）。
- **P0-4 部分**：语音链路——腾讯 ASR **已通**（`/api/voice/recognize`，前端 MediaRecorder + webm→16k WAV）；火山 TTS **未调通**（`55000000 resource ID mismatched`，用户去控制台换 seed-tts-2.0 匹配音色，后置）。
- **P0-5 已完成**：一致性——`image-prompt.ts` 结构化角色/场景卡 + 每帧自包含 prompt（固定前后缀）+ `consistency.ts` schema 校验；`image-jobs.ts` `buildWorldCards` 从库重建卡片（asset_clusters→characters→story_elements 逐层兜底去重）。tsc=0、28/28。
- **P0-6 已完成**：前端上线 + 家长端——reader **翻页回放**（封面/逐页/滑动/键盘/坏图占位）+ **家长端书架按孩子分组** + 移动端触控 44px + **魔法装饰层（旧版 UI 复用，只借装饰语言）+ 背景渐变 + touch-action** + 完成页「翻一翻」；PWA（manifest/icon/favicon）+ **fetch 全局兜底**（`apiFetch`：GET 5xx 自动重试、网络失败 toast，26 处替换 0 处裸 fetch）；管理员后台（admin.html + `/api/admin/*`）+ 部署骨架（Dockerfile/compose/nginx）+ **章节管理**（章节改名/删除 + 章节封面：默认该章第一页图、可上传替换，`chapters.cover_asset_id`）。
- **工具白名单现 9 个**；测试 **28/28**（7 文件）。

## 前端已知坑（改 index.html 时注意）

- server 每次 `GET /` 重读 `public/index.html`，改前端即时生效、**无需重启 server**；改 `src/*` 才需重启。**用户约定：改完代码不要代启 server 进程，由用户自己编译启动看终端日志。**
- `showConfirm()` 会用 `innerHTML` 替换 `#studio-actions`，**移除** `#pick-btn`/`#upload-btn`；`openChat` 必须每次重建，否则二次进入报 null。
- 上传图 `uri` 自带 `uploads/` 前缀，缩略图要 `uri.split("/").pop()`；图生图页图在 `uploads/<date>/` 子目录，需保留路径。
- 前端网络调用统一走 `apiFetch`（已全局替换），失败 toast + 恢复，避免卡死 UI。
- 魔法装饰层 `#km-sky` 固定定位 z-index:0、`pointer-events:none`；内容容器 `#app` 需 `z-index:1`，弹层（modal 40 / overlay 10）正常在上。

## git 纪律

- 只 `git add` 明确路径，禁 `add -A` / `reset --hard`。
- commit 格式：`{feat,fix,docs}(kidmagic): ...`。
- 未获用户要求不主动 commit；上游 Pi 目录一律不改。
