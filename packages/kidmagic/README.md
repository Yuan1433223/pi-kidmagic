# @earendil-works/pi-kidmagic

> Kidmagic 儿童创造力「故事机」——基于 [Pi](https://github.com/earendil-works/pi) 二开的独立产品包。
> 孩子把画作、手工和脑子里的想法讲出来，Agent 负责倾听、补缺、记录，并把孩子的**原话**整理成一本属于他自己的章节绘本。

面向 4–8 岁儿童及其家庭。产品的第一性原则是：

> **AI 可见度低，孩子主导度高。** 故事的情节、角色、结局由孩子产出，Agent 只做倾听、提问与连接词整理，绝不替孩子编故事。

本包是整条链路中可独立运行、可测试的领域内核：引导状态机、故事域工具、作品库与系统提示词。语音、前端与图生图在路线图上分阶段接入。

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
- [API 参考](#api-参考)
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
| Agent 运行时 | `pi-agent-core`：Agent 循环、细粒度事件流、`beforeToolCall` / `finishTurn` 钩子、工具执行 | 引导状态机、阶段裁决、白名单闸门、消息落库 |
| 模型与多模态 | `pi-ai`：多 provider 路由、图片输入、图生图、faux 测试 provider | 故事域提示词、人设 A/B、固定剧本 demo |
| 会话持久化 | `pi-session-backend-sqlite-node`（路线图接入） | 作品库十张表（`node:sqlite`） |
| 工程范式 | `pi-coding-agent` 的工具装配 / 钩子组织方式（仅参考，不引其代码） | 依赖注入工具工厂、离线确定性测试 |

依赖边界是硬约束：只 import 上游包的**顶层公开导出**，不引用 `src/` 内部路径，不复制上游代码。需要上游缺失的通用能力时，走 issue / PR 回流。

---

## 环境要求

- Node.js `>= 22.19.0`（依赖内置的 [`node:sqlite`](https://nodejs.org/api/sqlite.html)，当前为实验特性，运行时仅有一条 ExperimentalWarning，无需 flag）
- npm 10+
- 运行真实模型 demo 需要 OpenRouter API Key（离线测试不需要）

---

## 目录结构

```
packages/kidmagic/
├── package.json
├── tsconfig.json              # 开发/类型检查（含 scripts、test）
├── tsconfig.build.json        # 产物构建（仅 src）
├── AGENTS.md                  # 二开规范与领域上下文（给协作者与 AI coding）
├── scripts/
│   └── demo-script.ts         # 固定剧本 demo（真实模型，无 ASR）
├── src/
│   ├── index.ts               # 包入口，统一导出
│   ├── agent/
│   │   ├── stages.ts          # 阶段/人设/缺口类型、运行态、常量
│   │   ├── prompts.ts         # 人设 A/B + 核心规则 + 分阶段指令
│   │   └── story-agent.ts     # 装配：白名单闸门 + finishTurn 阶段机 + 消息持久化
│   ├── tools/
│   │   ├── types.ts           # ToolDeps、textResult/imageResult
│   │   ├── index.ts           # createKidmagicTools 工厂 + 白名单
│   │   ├── ingest-assets.ts
│   │   ├── magic-render.ts
│   │   ├── save-story-element.ts
│   │   ├── build-character-card.ts
│   │   ├── check-skeleton.ts
│   │   ├── save-book-title.ts
│   │   └── start-book-generation.ts
│   └── storage/
│       ├── schema.ts          # P0 十张表 DDL
│       ├── db.ts              # openDatabase（node:sqlite）
│       └── repo.ts            # 落库 helper 与主导性验收查询
└── test/
    ├── storage.test.ts        # 作品库与验收口径单测
    └── story-agent.smoke.test.ts  # faux 驱动的阶段机端到端冒烟
```

---

## 架构

```
                         孩子（语音 / 文本 / 素材）
                                  │
                                  ▼
 ┌──────────────────────────────────────────────────────────────┐
 │                         前端 / 语音链路                         │
 │        （P0 由固定剧本脚本替代；ASR/TTS、HTTP server 见路线图）      │
 └──────────────────────────────────────────────────────────────┘
                                  │ agent.prompt(text, images?)
                                  ▼
 ┌──────────────────────────────────────────────────────────────┐
 │                    createStoryAgent（pi-agent-core）            │
 │                                                                │
 │  systemPrompt = buildSystemPrompt(persona)   人设 A/B + 铁律     │
 │                                                                │
 │  beforeToolCall  ── 白名单闸门：7 个工具之外一律 block+terminate │
 │                                                                │
 │  tools = createKidmagicTools({ db, runtime })  依赖注入          │
 │                                                                │
 │  finishTurn     ── 工具驱动的阶段裁决（S0→S4，见下节）            │
 │                                                                │
 │  subscribe      ── message_end → session_messages 落库          │
 └───────────────┬───────────────────────────────┬────────────────┘
                 │ streamFn                       │ 工具 execute
                 ▼                                ▼
        pi-ai 多 provider 路由            ┌──────────────────────┐
        （OpenRouter / faux …）            │   作品库（node:sqlite） │
                                          │  assets / elements /  │
                                          │  characters / books / │
                                          │  chapters / pages …   │
                                          └──────────────────────┘
```

两条关键设计：

- **阶段机不依赖解析模型文本**。模型「说了什么」不可靠，「调用了哪个工具、传了什么结构化参数」才可靠。阶段切换由 `finishTurn` 钩子根据本回合工具结果裁决。
- **安全默认拒绝**。Agent 只能调用 7 个显式白名单工具，任何额外工具（包括 Pi 默认的 shell 类工具）在执行前即被拦截并终止该回合。

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
                                                                     第一章绘本落库
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
- **追问上限 2 轮**（`MAX_GAP_ROUNDS = 2`）。超过后即使仍有缺口也进入 S4，用已有内容收尾，避免把孩子问烦、问跑题。
- **一次只问一个问题**，并遵循「主角 → 在哪里 → 发生了什么 → 最后怎样」的优先级（由提示词约束）。
- **三级降级**（孩子不愿讲时）：换问法 → 给结合前文的选项 → 「今天先到这儿，已帮你存好」。P0 写入提示词，`runtime.fallbackLevel` 字段已为自动状态机预留。

---

## Agent 工具

工具由 `createKidmagicTools({ db, runtime })` 构造，参数 schema 使用 TypeBox，模型按 function-calling 协议调用。

| 工具 | 参数 | 阶段 | 副作用 |
|---|---|---|---|
| `ingest_assets` | `assetIds: string[]`<br>`clusterConfirmed?: boolean` | S0–S1 | 素材入库确认 / 半自动聚类确认闭环 |
| `magic_render` | `emotion: 'happy'\|'curious'\|'proud'`<br>`sceneHint?: string` | S1 | 魔法棒轻量反馈（P0 仅语义，动效在前端） |
| `save_story_element` | `elementType: 'character'\|'setting'\|'plotbeat'\|'emotion'\|'detail'\|'resolution'`<br>`content: string`（整理后内容）<br>`childWords: string`（孩子原话）<br>`orderIdx?: number` | S1–S3 | 写入 `story_elements`，**`childWords` 是主导性红线** |
| `build_character_card` | `name: string`<br>`appearance: string`<br>`personality: string`<br>`catchphrase?: string` | S1–S2 | upsert 进跨故事角色库，必要时关联当前绘本主角 |
| `check_skeleton` | `gaps: ('character'\|'setting'\|'conflict'\|'resolution')[]` | S2 | 写 `runtime.lastGaps`，驱动阶段裁决 |
| `save_book_title` | `title: string` | S4 | 创建/命名绘本 |
| `start_book_generation` | `artworkId: string`（封面素材）<br>`title: string`<br>`chapterNo?: number` | S4 | 建书 → 建章 → 逐元素排版成页 → 标记完成，**一次创作的终点** |

不暴露给模型、由系统层负责的能力（路线图）：`asr_transcribe`（讯飞儿童 ASR）、`generate_book_page`（图生图）、`persist_session`。

`start_book_generation` 的两个 P0 行为值得注意：

- **原话排版**：每个故事元素优先用 `child_words` 成页（`text_source='child_raw'`），无原话时退为连接词页（`connector`）；没有任何元素时兜底产出一页并标记为 `connector`，让主导性验收如实暴露问题。
- **封面容错**：模型给出的 `artworkId` 若不属于当前会话，回退到本会话最早上传的素材，避免一个不存在的 id 打断闭环。

---

## 作品库

P0 共 10 张表（DDL 见 `src/storage/schema.ts`），使用 Node 内置 SQLite，无原生编译依赖。

| 表 | 职责 |
|---|---|
| `assets` | 上传素材（画/照片/其他）+ `ner_entities`（JSON） |
| `asset_clusters` | 半自动聚类：角色组 / 场景组 / 道具组，`confirmed` 标记孩子是否确认 |
| `sessions` | 一次创作会话：`stage`、`status`（active/paused/completed）、当前绘本 |
| `session_messages` | user/assistant/tool 消息留痕，家长回放与后续 ASR 评估的数据源 |
| `story_elements` | 结构化故事元素，`child_words` 保留原话 |
| `characters` | **跨故事共享的本地角色库**（孩子的长期 IP），按 `name` 去重 |
| `books` | 绘本：标题、封面素材、状态（draft/generating/done） |
| `book_characters` | 绘本 ↔ 角色多对多，`role`（protagonist/supporting） |
| `chapters` | 章节，`recap_summary` 为续写时的「前情提要」预留 |
| `book_pages` | 绘本页：`text_source`（child_raw/connector/ai）、原画、`generated_image_uri` |

核心关系：

```
characters ──(book_characters, 多对多)── books ──< chapters ──< book_pages
sessions ──< story_elements
sessions ──< assets ──< asset_clusters
sessions ──< session_messages
```

---

## 主导性验收

「绘本是不是孩子自己讲出来的」不靠主观判断，而有可查询的口径：

- **原话占比**：`repo.childRawRatio(db, chapterId)` 返回 `{ childRaw, total, ratio }`，即该章页面中 `text_source='child_raw'` 的比例。P0 门槛 **≥ 0.6**。
- **零新增情节**：AI 只允许添加连接词（有一天 / 后来 / 然后 / 最后），不允许新增事件；系统提示词将此列为铁律，`story_elements` 中无 `child_words` 的情节元素可作为近似检查信号。

---

## API 参考

包入口 `@earendil-works/pi-kidmagic`：

```ts
// 装配一个故事 Agent
import { createStoryAgent, openDatabase, repo } from "@earendil-works/pi-kidmagic";

const db = openDatabase("./kidmagic.db"); // 默认 ":memory:"
const { agent, runtime, sessionId } = createStoryAgent({
  db,
  model,                 // pi-ai 的 Model 实例
  persona: "A",          // "A" 琪琪老师（默认） | "B" 动画伙伴
  // sessionId?,          // 传入则复用已有会话，否则新建并落库
  // streamFn?,           // 默认 pi-ai/compat 的 streamSimple；真实模型传 models.streamSimple.bind(models)
  // persistMessages?,    // 默认 true，消息落 session_messages
});

await agent.prompt("我今天画了一只小兔子……"); // 第二参可传 ImageContent[]
```

### `createStoryAgent(options): StoryAgentHandle`

| 选项 | 类型 | 说明 |
|---|---|---|
| `db` | `DatabaseSync` | 作品库句柄 |
| `model` | `Model<TApi>` | pi-ai 模型实例 |
| `persona` | `"A" \| "B"` | 人设，默认 `"A"` |
| `sessionId` | `string` | 复用会话；省略则新建 |
| `streamFn` | `StreamFn` | 流式函数，默认 compat 实现 |
| `persistMessages` | `boolean` | 是否落消息，默认 `true` |

返回 `{ agent, runtime, sessionId }`：`agent` 是标准 Pi `Agent`（`prompt` / `subscribe` / `state` / `waitForIdle`），`runtime` 是当前会话的进程内运行态。

### 运行态与常量（`src/agent/stages.ts`）

```ts
type StoryStage    = "S0" | "S1" | "S2" | "S3" | "S4";
type Persona       = "A" | "B";
type FallbackLevel = "none" | "rephrase" | "choice" | "pause";
type SkeletonGap   = "character" | "setting" | "conflict" | "resolution";

interface StoryRuntime {
  sessionId: string;
  stage: StoryStage;
  persona: Persona;
  fallbackLevel: FallbackLevel;
  gapRoundCount: number;     // 当前缺口追问轮数
  lastGaps: SkeletonGap[];   // 最近一次框架缺口
  pendingAssetIds: string[];
  bookId?: string;
  chapterId?: string;
}

const MAX_GAP_ROUNDS = 2;        // 缺口追问上限
const MAX_FALLBACK_RETRIES = 2;  // 降级重试上限（预留）
```

### 工具工厂与提示词

```ts
createKidmagicTools(deps: { db, runtime }): AgentTool<TSchema, unknown>[];
KIDMAGIC_TOOL_NAMES: readonly string[];   // 白名单
buildSystemPrompt(persona: "A" | "B"): string;
```

### 存储层（`repo` namespace）

会话 / 素材：`createSession` · `updateSessionStage` · `insertAsset` · `upsertCluster` · `confirmCluster` · `insertMessage`
故事元素 / 角色：`insertStoryElement` · `upsertCharacter` · `getCharacterByName`
绘本：`createBook` · `setBookTitle` · `linkBookCharacter` · `createChapter` · `insertBookPage` · `markBookDone`
查询 / 验收：`getBook` · `listPages` · `listStoryElements` · `childRawRatio`

---

## 快速开始

本包位于 Pi monorepo 中，依赖上游包的构建产物（`dist/` 不入库）。首次检出后，需在仓库根按依赖顺序构建 `pi-telemetry → pi-chord → pi-ai → pi-agent-core → pi-session-backend-sqlite-node`（其中 `pi-ai` 需先运行模型目录拉取脚本 `hydrate:model-data`）。

以下命令均在仓库根用 workspace 形式运行（也可在 `packages/kidmagic` 内直接 `npm run <script>`）：

```bash
# 类型检查（覆盖 src / scripts / test）
npm run check --workspace=@earendil-works/pi-kidmagic

# 构建产物到 dist/
npm run build --workspace=@earendil-works/pi-kidmagic

# 离线测试（faux provider + 内存库，不触网、不计费）
npm run test --workspace=@earendil-works/pi-kidmagic
```

跑真实模型的固定剧本 demo（会产生 OpenRouter 调用费用）：

```powershell
# PowerShell
$env:OPENROUTER_API_KEY = "sk-or-..."
$env:OPENROUTER_MODEL   = "google/gemini-2.5-flash"   # 可选，默认即此
$env:KIDMAGIC_PERSONA   = "A"                          # 可选，A / B
npm run demo --workspace=@earendil-works/pi-kidmagic
```

demo 会模拟上传两张素材、逐句给出一段「缺结尾」的孩子台词，打印每次工具调用与最终绘本（页内容、原话占比、故事元素、角色库），并在包目录生成 `kidmagic-demo.db`。

---

## 测试

测试全部离线、确定性，禁止真实网络与密钥：

- **模型**使用 pi-ai 的 faux provider（`registerFauxProvider` / `fauxAssistantMessage` / `fauxToolCall`，来自 `@earendil-works/pi-ai/compat`），按模型被消费的顺序排队响应；
- **数据库**统一使用 `openDatabase(":memory:")`，每个用例独立。

| 文件 | 覆盖 |
|---|---|
| `test/storage.test.ts` | 十表初始化、角色库去重、绘本–角色多对多、`childRawRatio` 口径、原话留存 |
| `test/story-agent.smoke.test.ts` | S0→S4 完整闭环并生成原话章节、缺口追问 2 轮上限、非白名单工具被拦截且不执行 |

新增产品规则（阶段切换、工具约束、验收口径）时，应同步补充对应断言。

---

## 扩展点与路线图

架构为以下能力预留了明确位置，按阶段解锁：

- **语音链路（ASR/TTS）**：ASR 计划接入讯飞儿童识别（儿童口音是硬门槛），作为系统层工具 `asr_transcribe`，不进模型白名单；TTS 音色在交互定稿后接入。`agent.prompt` 已支持文本之外的 `ImageContent`。
- **素材多模态理解与半自动聚类**：`assets.ner_entities`、`asset_clusters` 表与 `ingest_assets` / `upsertCluster` / `confirmCluster` 已就位；P0 不做真实 NER，P1 接入多模态模型识别实体，聚类结果仍需孩子「对吗？」确认后才 `confirmed=1`。
- **绘本配图（图生图）**：`book_pages.image_asset_id` / `generated_image_uri` 与 `imageResult()` 已预留；pi-ai 当前内置图生图走 OpenRouter（gemini-image）。计划为封面用原画、内页图生图并尝试主角一致性，失败一律退回原画排版，不阻塞出片。
- **二次使用与留存（P1）**：「我的故事集」、章节续写、新的开始。续写采用**新 session + 注入 `chapters.recap_summary` 前情提要**，不续旧 session；「老角色」通过角色库取出角色卡作为上下文带入，新角色继续沉淀进 `characters`。这是产品生命周期与孩子长期 IP 的承载。
- **三级降级自动状态机**：`runtime.fallbackLevel` 与 `MAX_FALLBACK_RETRIES` 已预留，P0 仅靠提示词，待真实语料校准后再下沉为确定性逻辑。
- **会话持久化**：接入 `pi-session-backend-sqlite-node` 管理 Agent 对话状态，与作品库分工（前者管对话运行态，后者管创作产物）。
- **载体**：H5 前端 + Node 单服务（移动端优先），魔法棒反馈等轻量动效在前端实现。
- **账号化（P2）**：P0/P1 角色库与作品库为设备本地 SQLite，账号与云同步在 P2。

---

## 已知限制

- 当前 demo 为**无 ASR 的固定剧本**，用于验证「孩子愿意讲 + 引导有效 + 绘本保留主导性」三件事，语音与前端尚未接入。
- 三级降级、「生成前必须获得孩子明确同意」目前由系统提示词约束，尚无工具层硬保证；在模型服从度未经真实语料验证前，这两点是优先观察项。
- P0 不调用图生图，绘本页只做原话文本排版，页图字段为空。
- `node:sqlite` 在 Node 22 线上仍标记为实验特性（仅警告）；升级 Node 大版本时需回归。
- 人设 B 中的参考卡通形象为注册商标，仅可用于内部 demo，正式上线必须替换为原创形象。

---

## 许可证

MIT，基于 [earendil-works/pi](https://github.com/earendil-works/pi) 二次开发，保留上游版权声明。
