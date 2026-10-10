# @earendil-works/pi-kidmagic

> Kidmagic 儿童创造力「故事机」——基于 [Pi](https://github.com/earendil-works/pi) 二开的独立产品包。
> 孩子把画作、手工和脑子里的想法讲出来，Agent 负责倾听、补缺、记录，并把孩子的**原话**整理成一本属于他自己的章节绘本。

面向 4–8 岁儿童及其家庭。产品的第一性原则是：

> **AI 可见度低，孩子主导度高。** 故事的情节、角色、结局由孩子产出，Agent 只做倾听、提问与连接词整理，绝不替孩子编故事。

本包是整条链路的领域内核 + 工作台服务端：引导状态机、故事域工具、作品库、HTTP server 与 H5 工作台。语音（ASR/TTS）已部分接入（ASR 通，TTS 调音色中）。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [与 Pi 的关系](#与-pi-的关系)
- [环境要求](#环境要求)
- [目录结构](#目录结构)
- [架构](#架构)
- [引导状态机](#引导状态机)
- [Agent 工具](#agent-工具)
- [作品库](#作品库)
- [主导性验收](#主导性验收)
- [工作台 HTTP API](#工作台-http-api)
- [包 API 参考](#包-api-参考)
- [快速开始](#快速开始)
- [测试](#测试)
- [扩展点与路线图](#扩展点与路线图)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 它解决什么问题

这个年龄段的孩子表达欲强、想法多，但叙事往往是碎片化的：主角、场景、冲突、结尾混在一起，讲着讲着就断了。家长想要的是「高质量陪伴 + 看得见的成长」，孩子想要的是「我创造出了一个东西，并被看见」。

Kidmagic 不做又一个「AI 一键生成故事」的玩具。它把一次创作拆成三步，且每一步的主导权都在孩子手里：

1. **开始前**——引导孩子上传素材、建立表达框架，学会使用工具；
2. **创作中**——充分尊重主观能动性，Agent 只在故事「讲不下去」时补最少的问题；
3. **完成后**——产出可留存、可回看、可续写的绘本，让家长看见孩子的表达，让孩子拥有自己的作品与角色。

与同类「故事机 / 拍学机」的关键差异：**孩子必须有真实作品产出，且作品文本可被量化地证明来自孩子本人，而非模型代笔。**

---

## 与 Pi 的关系

本包是 Pi monorepo 中的一个独立 package，遵循「拿来主义」：底座直接复用，产品逻辑全部独立，不修改任何上游包源码。

| 层 | 复用的 Pi 能力 | 本包自建 |
|---|---|---|
| Agent 运行时 | `pi-agent-core`：Agent 循环、事件流、`beforeToolCall` / `finishTurn` 钩子、工具执行 | 引导状态机、阶段裁决、白名单闸门、消息落库 |
| 模型与多模态 | `pi-ai`：多 provider 路由、图片输入、图生图、faux 测试 provider | 故事域提示词、人设 A/B、图生图封装、固定剧本 demo |
| 会话持久化 | — | 作品库 15 张表（PostgreSQL，repo 全异步） |
| 工程范式 | `pi-coding-agent` 的工具装配 / 钩子组织（仅参考，不引代码） | 依赖注入工具工厂、离线确定性测试、HTTP server + H5 |

依赖边界是硬约束：只 import 上游包的**顶层公开导出**，不引用 `src/` 内部路径，不复制上游代码。需要上游缺失的通用能力时，走 issue / PR 回流。

---

## 环境要求

- Node.js `>= 22.19.0`（`node:sqlite` 仅用于离线测试/脚本，实验特性仅一条警告；推荐 22.23.x）
- npm 10+
- **PostgreSQL 18+**：作品库（`DATABASE_URL`，见 `.env`；云上走 docker compose 起 pg）
- **Redis**（BullMQ 图生图异步队列，P0-2）：本地用 Memurai 提供 Redis 兼容服务（`localhost:6379`）；不可用时图生图自动降级为同步，server 照常跑
- 真机对话 / 视觉理解 / 图生图需要百炼专属实例或套餐的 key（离线测试不需要）

---

## 目录结构

```
packages/kidmagic/
├── package.json
├── tsconfig.json / tsconfig.build.json
├── AGENTS.md                  # 二开规范 + 工程地图（给协作者与 AI coding）
├── README.md
├── .env / .env.example        # 模型 key 等（.env 已 gitignore）
├── public/
│   ├── index.html             # H5 工作台前端（单文件内联 CSS/JS，儿童风 token + emoji + 魔法装饰层）
│   ├── admin.html             # P0-6 管理员后台页
│   ├── manifest.webmanifest   # PWA
│   └── icon.svg               # PWA 图标
├── deploy/                    # 云上部署（Dockerfile / docker-compose.yml / nginx / env.production）
├── scripts/
│   ├── demo-script.ts         # 单章真机 demo（固定剧本）
│   ├── demo-continuation.ts   # 章节续写真机 demo
│   └── smoke-image.ts         # 图生图真机冒烟
├── src/
│   ├── index.ts               # 包入口，统一导出
│   ├── server.ts              # node:http 工作台服务端（JSON API + 静态页）
│   ├── auth.ts                # P0-3 账号：scrypt 密码哈希 + HMAC JWT（零第三方）
│   ├── agent/
│   │   ├── stages.ts          # 阶段/人设/缺口类型、运行态、常量
│   │   ├── prompts.ts         # 人设 A/B + 核心规则 + 分阶段指令 + 续写前缀
│   │   ├── story-agent.ts     # 装配：白名单闸门 + finishTurn 阶段机 + 消息持久化
│   │   ├── summary.ts         # 前情提要摘要 buildRecapSummary
│   │   ├── image-prompt.ts    # P0-5 结构化角色/场景卡 + 每帧自包含 prompt
│   │   ├── consistency.ts     # P0-5 一致性 schema 校验
│   │   ├── asset-context.ts   # 素材→agent 上下文注入
│   │   ├── reference-asset.ts # 主角参考图（孩子原画）
│   │   └── qwen-dedicated.ts  # 百炼专属实例 provider（id qwen-dedicated）
│   ├── tools/
│   │   ├── types.ts / index.ts
│   │   ├── ingest-assets.ts / analyze-ingest-batch.ts
│   │   ├── magic-render.ts / save-story-element.ts
│   │   ├── build-character-card.ts / check-skeleton.ts / get-world-state.ts
│   │   ├── save-book-title.ts / start-book-generation.ts / paginate.ts / world-state.ts
│   ├── vision/
│   │   ├── visual-understand.ts  # 图片 → 结构化实体（qwen 多模态）
│   │   └── ingest-cluster.ts     # 素材理解 + 聚类服务（工具 & server 共用）
│   ├── image/
│   │   ├── dashscope-image.ts    # 通义万相图生图封装（同步/异步兼容）
│   │   └── image-prompt.ts
│   ├── jobs/
│   │   ├── image-jobs.ts          # 章节配图核心（worker/同步共用，P0-5 buildWorldCards）
│   │   └── queue.ts               # BullMQ Queue/Worker 工厂（Redis）
│   ├── voice/
│   │   ├── tencent-asr.ts         # 腾讯云一句话识别（已通）
│   │   └── volc-tts.ts            # 火山单流 SSE TTS（调音色中）
│   ├── util/save-image.ts         # 图生图结果下载落盘（防外链过期）
│   └── storage/
│       ├── db-pg.ts / schema-pg.ts / repo.ts   # PostgreSQL 作品库（15 表，repo 全异步）
│       └── db.ts / schema.ts                    # SQLite（sqliteDbAdapter 供离线测试/脚本）
└── test/                       # vitest 离线测试（faux provider + :memory: db，28 用例）
```

---

## 架构

```
         孩子（H5 工作台：上传画作 → 确认聚类 → 打字机对话 → 完成感 → 翻页回看绘本）
                                  │
                                  ▼
        node:http server（src/server.ts）
          静态 H5（/、/admin、/manifest、/icon.svg）
          /api/auth/*（注册/登录/me/children）· /api/voice/*（ASR/TTS）
          /api/admin/*（管理后台，设 KIDMAGIC_ADMIN_PASSWORD 启用）
          /books·/books/:id·/uploads·/sessions/:id/messages·…
                                  │ agent.prompt / 工具 execute
                                  ▼
 ┌──────────────────────────────────────────────────────────┐
 │                createStoryAgent（pi-agent-core）           │
 │   systemPrompt = buildSystemPrompt(persona) 人设 A/B + 铁律 │
 │   beforeToolCall ── 白名单闸门（9 工具之外 block+terminate） │
 │   tools = createKidmagicTools({ db, runtime }) 依赖注入      │
 │   finishTurn ── 工具驱动阶段裁决（S0→S4）                     │
 │   subscribe ── message_end → session_messages 落库          │
 └──────────────┬──────────────────────────┬─────────────────┘
        streamFn │                          │ 工具 execute
                ▼                          ▼
     pi-ai 多 provider 路由         ┌──────────────────────┐
     （qwen-dedicated / 套餐 /      │ 作品库（PostgreSQL） │
       OpenRouter / faux）         │  15 张表              │
       视觉理解：qwen 多模态        └──────────▲───────────┘
       图生图：通义万相                       │
              ▲                              │
              └── BullMQ 异步队列 ───────────┘
       start_book_generation 文字同步落地 → 配图入队后台串行生成
       → 画布边生成边铺页；队列不可用自动降级同步（P0-2）
```

两条关键设计：

- **阶段机不依赖解析模型文本**。模型「说了什么」不可靠，「调用了哪个工具、传了什么结构化参数」才可靠。阶段切换由 `finishTurn` 钩子根据本回合工具结果裁决。
- **安全默认拒绝**。Agent 只能调用白名单内的 9 个工具，任何额外工具在执行前即被拦截并终止该回合。
- **视觉理解 / 图生图走独立服务**（`src/vision`、`src/image`、`src/jobs`），工具与 server 共用同一逻辑。

---

## 引导状态机

阶段不是硬编码的对话树，而是「运行态 + 分阶段提示词 + 工具出口裁决」的组合。

```
 S0 见面                S1 倾听 + 魔法反馈        S2 缺口推理
 引导上传素材/开口  ─►   记录元素/角色卡/魔法棒 ─►  check_skeleton
                                                    │
                              ┌─────────────────────┴──────────────────┐
                              ▼ 有缺口且追问 < 2 轮                       ▼ 无缺口 / 已达上限
                         S3 最少追问（只问大框架缺口）                S4 概括确认
                              │  孩子补充后回到 check_skeleton          用原话复述 → 起名
                              └──────────────► S4                       → 孩子同意
                                                                   start_book_generation
                                                                          │ end ▼
                                                                     第一章绘本落库（含配图）
```

| 阶段 | 名称 | 主要工具 | 出口 |
|---|---|---|---|
| S0 | 见面 | `ingest_assets` | 素材就绪、孩子开口 |
| S1 | 倾听 + 魔法反馈 | `save_story_element` `build_character_card` `magic_render` `check_skeleton` | 一大段讲述结束 |
| S2 | 缺口推理 | `check_skeleton` | 得到缺口清单 |
| S3 | 最少追问 | 同 S1，仅围绕缺口 | 缺口补齐或达到 `MAX_GAP_ROUNDS`（2 轮） |
| S4 | 概括确认 | `save_book_title` `start_book_generation` | 孩子同意，生成第一章 |

约束：

- **大框架完整优先于细节发散**。缺口只认四类：`character` / `setting` / `conflict` / `resolution`；情绪、细节等「血肉」不主动追问。
- **追问上限 2 轮**（`MAX_GAP_ROUNDS = 2`）。超过后即使仍有缺口也进入 S4。
- **一次只问一个问题**，遵循「主角 → 在哪里 → 发生了什么 → 最后怎样」的优先级。
- **三级降级**（孩子不愿讲时）：换问法 → 给结合前文的选项 → 「今天先到这儿，已帮你存好」。

---

## Agent 工具

工具由 `createKidmagicTools({ db, runtime })` 构造，参数 schema 用 TypeBox，模型按 function-calling 协议调用。

| 工具 | 参数 | 阶段 | 副作用 |
|---|---|---|---|
| `ingest_assets` | `assetIds: string[]`<br>`clusterConfirmed?: boolean` | S0–S1 | 素材入库确认 / 半自动聚类确认闭环 |
| `analyze_ingest_batch` | `batchNo: number` | S1 | 对该批素材做视觉理解 + 聚类（薄壳 → `ingest-cluster.ts`） |
| `magic_render` | `emotion: 'happy'\|'curious'\|'proud'`<br>`sceneHint?: string` | S1 | 魔法棒轻量反馈（语义层；动效在前端） |
| `save_story_element` | `elementType: 'character'\|'setting'\|'plotbeat'\|'emotion'\|'detail'\|'resolution'`<br>`content`<br>`childWords`（孩子原话）<br>`orderIdx?` | S1–S3 | 写入 `story_elements`，**`childWords` 是主导性红线** |
| `build_character_card` | `name`<br>`appearance`<br>`personality`<br>`catchphrase?` | S1–S2 | upsert 进跨故事角色库 |
| `check_skeleton` | `gaps: ('character'\|'setting'\|'conflict'\|'resolution')[]` | S2 | 写 `runtime.lastGaps`，驱动阶段裁决 |
| `save_book_title` | `title: string` | S4 | 创建/命名绘本（不覆盖已有书标题） |
| `get_world_state` | （无） | S1–S4 | 查询世界状态：角色/场景/本书全部章节前情；续写或不确定时先查，保持连续 |
| `start_book_generation` | `artworkId`（封面素材）<br>`title`<br>`chapterNo?` | S4 | 建书→建章→逐元素排版成页→配图（BullMQ 队列）→标记完成 |

`start_book_generation` 的关键行为：

- **原话排版**：每个故事元素优先用 `child_words` 成页（`text_source='child_raw'`），无原话时退为连接词页（`connector`）；无元素时兜底一页并标记 `connector`。
- **配图（P0-2/P0-5）**：文字页 done 后**串行**为每页生成图；worker 内 `buildWorldCards` 从库重建角色/场景卡 → `validateChapterPage` schema 校验 → 失败单页降级纯文字。队列不可用自动降级同步。
- **续写**：带 `continuation` 时挂原书（不新建书），按 `chapterNo` 写章节。

不暴露给模型、由系统层负责的能力：`asr_transcribe`（腾讯云，`/api/voice/recognize`）、TTS（`/api/voice/tts`）。

---

## 作品库

共 **15 张表**（DDL 见 `src/storage/schema-pg.ts`），**PostgreSQL**（`db-pg.ts` 的 pg.Pool，`repo.ts` 40+ 函数全异步、`$n` 占位、事务级联删书）。离线测试与 demo 脚本用 `db.ts` 的 SQLite 适配（`sqliteDbAdapter`）跑 `:memory:` 库。

| 表 | 职责 |
|---|---|
| `assets` | 上传素材（画/照片）+ `ner_entities`（JSON） |
| `asset_clusters` | 半自动聚类：角色组/场景组/道具组，`confirmed` 标记孩子是否确认 |
| `ingest_items` | 素材上传暂存批次（批次原子性、批量≤10、confirm/discard） |
| `sessions` | 一次创作会话：`stage`、`status`、当前绘本 |
| `session_messages` | user/assistant/tool 消息留痕（回放与 ASR 评估数据源） |
| `story_elements` | 结构化故事元素，`child_words` 保留原话 |
| `characters` | **跨故事共享的本地角色库**（孩子的长期 IP），按 `name` 去重 |
| `books` | 绘本：标题、封面素材、状态（draft/generating/done）、**`user_id/child_id` 归属** |
| `book_characters` | 绘本 ↔ 角色多对多，`role`（protagonist/supporting） |
| `chapters` | 章节，`recap_summary` 为续写时的「前情提要」，`cover_asset_id` 为章节封面（默认取该章第一页图，可上传替换） |
| `book_pages` | 绘本页：`text_source`（child_raw/connector）、原画、`generated_image_uri` |
| `users` | 家长账号（手机号唯一、scrypt 密码哈希、昵称） |
| `children` | 孩子档案（`user_id` 外键 ON DELETE CASCADE） |
| `invite_batches` / `invite_codes` | 管理员邀请码批次 + 码（P0-6） |

核心关系：

```
users ──< children ──< books ──< chapters ──< book_pages
characters ──(book_characters)── books
sessions ──< story_elements / assets / asset_clusters / session_messages
books ──< ingest_items（上传批次）
invite_batches ──< invite_codes
```

---

## 主导性验收

- **原话占比**：`repo.childRawRatio(db, chapterId)` 返回 `{ childRaw, total, ratio }`。P0 门槛 **≥ 0.6**。
- **零新增情节**：AI 只允许加连接词，`story_elements` 中无 `child_words` 的情节元素可作为近似检查信号。

---

## 工作台 HTTP API

`src/server.ts` 提供 node:http 服务（默认 `PORT=8787`，静态 H5 + JSON API）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | H5 工作台首页（`public/index.html`） |
| GET | `/admin` | 管理员后台页（设 `KIDMAGIC_ADMIN_PASSWORD` 启用） |
| GET | `/manifest.webmanifest` / `/icon.svg` | PWA 静态资产 |
| GET | `/health` | 健康检查（含 provider/model） |
| POST | `/api/auth/register` | 注册（手机号 `^1\d{10}$`、密码≥6、token 30 天） |
| POST | `/api/auth/login` | 登录 → JWT |
| GET | `/api/me` | 登录态 + 孩子列表 |
| POST | `/api/children` | 新建孩子档案 |
| POST | `/api/voice/recognize` | 腾讯 ASR（16k WAV；不配 key 返回 501） |
| POST | `/api/voice/tts` | 火山 TTS（不配 key 返回 501；当前音色待调） |
| POST | `/api/admin/login` | 管理员登录 |
| GET | `/api/admin/overview` / `users` / `books` / `invite-batches` / `invite-codes` | 管理统计/列表 |
| POST | `/api/admin/invite-batches` | 生成邀请码批次 |
| GET | `/books` | 书列表（按 user/child 归属过滤，游客看全部） |
| GET | `/books/:id` | 书详情（章节列表） |
| POST | `/books` | 新建书 + 会话 `{title}` → `{bookId, sessionId}` |
| POST | `/books/:id/continue` | 续写最新章之后（无章节则首章） |
| PATCH / DELETE | `/books/:id` | 重命名 / 删除整本书（级联） |
| PATCH | `/books/:id/chapters/:cid` | 章节改名（`{title}`） |
| DELETE | `/books/:id/chapters/:cid` | 删除章节（级联删该章绘本页） |
| POST | `/books/:id/chapters/:cid/cover` | 章节封面上传（base64）→ `{cover_asset_id}` |
| POST | `/books/:id/uploads` | base64 上传图片（每批 ≤10）→ `{batchNo, items}` |
| POST | `/books/:id/uploads/confirm` / `discard` | 确认 / 丢弃一批 |
| POST | `/books/:id/uploads/:batch/analyze` | 视觉理解 + 聚类 → `{ok, labels}` |
| POST | `/sessions/:id/messages` | 孩子说话 → `{reply, stage, gapRoundCount, feedback}` |
| GET | `/uploads/:file` | 取上传原图 / 图生图页图（防路径穿越） |
| GET | `/books/:id/assets` | 整书角色/场景资产 + 角色卡详情 |
| GET | `/books/:id/materials` | 素材碎片（已确认上传原图） |
| GET | `/books/:id/latest-chapter/pages` | 最新一章页面（画布轮询 / 完成页「翻一翻」） |
| GET | `/sessions/:id/assets` | 会话角色/场景资产 |

对话接口当前为非流式 JSON，前端用**打字机动画**模拟流式（真 SSE 后置）。

---

## 包 API 参考

包入口 `@earendil-works/pi-kidmagic`：

```ts
import { createStoryAgent, openPgDatabase, repo } from "@earendil-works/pi-kidmagic";

const db = await openPgDatabase(process.env.DATABASE_URL!);
const { agent, runtime, sessionId } = createStoryAgent({
  db, model, persona: "A",
  // continuation?: { bookId, recapSummary, chapterNo }  // 续写
});
await agent.prompt("我今天画了一只小兔子……"); // 第二参可传 ImageContent[]
```

### `createStoryAgent(options): StoryAgentHandle`

| 选项 | 类型 | 说明 |
|---|---|---|
| `db` | `Db` | 作品库句柄（`openPgDatabase` 连 PG；测试/脚本用 `sqliteDbAdapter(openDatabase(":memory:"))`） |
| `model` | `Model<TApi>` | pi-ai 模型实例 |
| `persona` | `"A" \| "B"` | 人设，默认 `"A"` |
| `sessionId` | `string` | 复用会话；省略则新建 |
| `continuation` | `{ bookId; recapSummary; chapterNo? }` | 续写（recapSummary 为空则按首章开始） |
| `streamFn` | `StreamFn` | 流式函数，默认 compat 实现 |
| `persistMessages` | `boolean` | 是否落消息，默认 `true` |

---

## 快速开始

本包位于 Pi monorepo 中，依赖上游包构建产物（`dist/` 不入库）。首次检出后在仓库根按依赖顺序构建上游包。以下命令在仓库根用 workspace 形式运行：

```bash
# 类型检查 / 离线测试（faux + :memory:，不触网不计费）
npm run check --workspace=@earendil-works/pi-kidmagic
npm run test  --workspace=@earendil-works/pi-kidmagic
```

真机（需 `.env`，见 `packages/kidmagic/.env.example`）：

```bash
npm run demo --workspace=@earendil-works/pi-kidmagic
npm run demo:continuation --workspace=@earendil-works/pi-kidmagic
npm run smoke:image --workspace=@earendil-works/pi-kidmagic

# 启动工作台（在 packages/kidmagic 内）
cd packages/kidmagic && npm run server   # http://localhost:8787
```

真机对话 / 视觉理解 / 图生图走百炼（`.env` 的 `QWEN_BASE_URL` + `QWEN_API_KEY`/`DASHSCOPE_API_KEY`），provider 选择：专属实例 > 公共套餐 > OpenRouter。

---

## 测试

测试全部离线、确定性，禁止真实网络与密钥（模型用 pi-ai faux provider，数据库统一 `:memory:`）。

| 文件 | 覆盖 |
|---|---|
| `test/storage.test.ts` | 15 表初始化、角色库去重、绘本–角色多对多、`childRawRatio` 口径、账号/孩子 |
| `test/story-agent.smoke.test.ts` | S0→S4 完整闭环、缺口追问 2 轮上限、非白名单工具被拦截 |
| `test/continuation.test.ts` | 章节续写闭环（新 session + 前情提要、章节号正确、书标题不覆盖） |
| `test/ingest-cluster.test.ts` | 素材理解 + 聚类服务逻辑 |
| `test/image-gen.test.ts` | 图生图封装（同步/异步、失败降级、无 key 不触网） |

当前 **28 用例全绿**（`npx tsc -p tsconfig.json --noEmit` = 0）。新增产品规则应同步补断言。

---

## 扩展点与路线图

已完成：

- **P0** 单次完整流程闭环
- **P1-B** 章节续写（新 session + 前情提要注入，挂同一本书）
- **P1-A** 工作台 server + H5（首页/起名/书详情/画室/对话/完成感/回看）+ 视觉理解聚类 + 图生图接入 + 画布「生长」+ 资产弹窗 + 书列表增删改
- **P1/P2/P3** 图生图世界状态注入、主角参考图、对话侧连续（`get_world_state` + 素材注入）
- **429 限流修复**；**图生图结果落盘**（`saveRemoteImage` 防外链过期）
- **P0-1** 存储 → PostgreSQL（repo 全异步，SQLite 适配保留）
- **P0-2** BullMQ 图生图异步化（job data 不含敏感信息，Redis 降级同步）
- **P0-3** 账号体系（家长手机号+密码 + 孩子档案 + JWT + 归属过滤），游客免登录保留
- **P0-4 部分** 语音：腾讯 ASR 已通（`/api/voice/recognize`）；火山 TTS 待换可用音色
- **P0-5** 一致性：角色/场景卡 + 每帧自包含 prompt + schema 校验
- **P0-6** 前端上线 + 家长端（翻页回放 / 家长书架 / 移动端健壮性 / PWA / fetch 全局兜底）+ 魔法装饰层（旧版 UI 复用）+ 管理员后台 + 部署骨架

待做：

- **语音 TTS**：火山控制台换 `seed-tts-2.0` 匹配音色后接通；前端语音按钮打通。
- **对话真 SSE**：当前打字机动画模拟。
- **主角一致性验收自动化**：P0-5 世界卡已落地，可加同角色跨页一致性自动断言。
- **视觉理解细化**：实体 label → 结构化外观描述，喂给 `build_character_card`。
- **账号深化**：短信验证码、游客书迁移到账号、多孩子隔离到多租户级。

---

## 已知限制

- 当前交互以文本输入 + 打字机回复为主，语音链路 ASR 已通、TTS 调音色中。
- 三级降级、「生成前必须获得孩子明确同意」目前由系统提示词约束，尚无工具层硬保证。
- 图生图对**过于抽象/无具象元素的原话**可能降级为纯文字页（不阻塞出片）；配图质量与主角一致性待真机复测调优。
- 本地需 **PostgreSQL + Redis（Memurai）** 才能跑工作台完整异步配图；Redis 不可用时图生图降级同步。
- 本地 Windows 曾尝试 Docker/Podman 因系统虚拟化问题不可用，容器仅作**云上标准部署**（deploy/docker-compose）。
- 人设 B 中参考卡通形象为注册商标，仅限内部 demo，正式上线必须替换为原创形象。

---

## 许可证

MIT，基于 [earendil-works/pi](https://github.com/earendil-works/pi) 二次开发，保留上游版权声明。
