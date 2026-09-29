# Kidmagic 二开开发规范（中文版）

> 本文件改编自上游 `earendil-works/pi` 的 `AGENTS.md`，针对 `packages/kidmagic` 二开场景本地化与裁剪。
> 中文、面向本包开发。上游规范与本文件冲突时，以不违背上游精神、且更贴合本包实际情况的写法为准。
> 对 AI coding 与协作者而言，这是本包开发的**唯一权威规范 + 领域上下文**。

---

## 1. 项目定位

- **Kidmagic = 儿童创造力「故事机」**。基于 Pi 二开：孩子把画作/素材讲成故事，生成**章节化**的故事绘本。
- **复用 Pi（拿来主义）**：`@earendil-works/pi-agent-core`（Agent 循环/事件流/finishTurn/工具执行）、`@earendil-works/pi-ai`（多模型路由/图片输入/图生图）、`@earendil-works/pi-session-backend-sqlite-node`（会话持久化）。
- **自建（独立层）**：引导状态机（S0-S4）、7 个 AgentTool、HTTP server、作品库 storage、prompt（人设 A/B）、讯飞 ASR 接入、绘本生成管线、二次使用模块（P1）。
- **载体**：Web 应用、移动端优先，H5 前端 + Node 单服务后端。

---

## 2. 依赖边界（最高优先级，违反即违反设计意图）

- **允许**：`import` 上述 Pi 包（`pi-agent-core` / `pi-ai` / `pi-session-backend-sqlite-node`）的**顶层公开导出**。
- **禁止**：
  - `import` 任何 `pi-*/src/...` 内部路径；
  - 依赖未文档化的内部行为；
  - 在 fork 里修改任何 Pi 包源码（`agent-core`/`ai`/`coding-agent` 等保持与上游 `git diff` 为空）；
  - 把 Pi 代码复制进本包。
- **验收标准**：本包能改的只有 kidmagic 自己的文件；Pi 目录全部当「黑盒依赖」。
- **遇到「想要 Pi 内部能力但没公开 API」的需求** → 写 issue/PR 回上游，不 hack 内部。

---

## 3. 产品领域上下文（给 AI coding 的锚点）

### 3.1 产品原则
> **AI 可见度低，孩子主导度高。** 故事文案 90% 是孩子原话，AI 只做连接词整理（"有一天/后来/最后"），**禁止新增情节**。绘本是否保留孩子主导性 = 验收红线。

### 3.2 完整流程（P0 单次完整流程）
```
① 素材管线：孩子逐个上传素材 → NER 命名实体识别 → 相关性聚类（半自动）→ 资产库
② 故事确定：S0 见面 → S1 倾听+魔法反馈 → S2 缺口推理 → S3 最少追问(≤2轮) → S4 概括确认
③ 绘本生成：第一章（原画 + 孩子原话 + 图生图可选）
（P1）④ 二次使用：我的故事集 / 章节续写 / 新的开始（角色库复用）
```

### 3.3 素材管线（NER 半自动聚类）
- 孩子**先逐个上传素材**（多张画/元素），**再一口气讲述**（时序已定，勿改）。
- 素材理解：用 pi-ai 多模态模型识别每个素材的实体（人/动物/场景/道具）。
- 聚类：按相关性聚成**角色组/场景组/道具组**。**半自动**——AI 先展示"我看到有 X（小熊）、Y（大树），对吗？"，孩子确认后才定组，保护主导性。
- 落库：`assets` + `asset_clusters`（见 3.7）。

### 3.4 引导状态机（S0-S4 演进版）
| 阶段 | 名称 | 动作 | 出口条件 |
|---|---|---|---|
| S0 | 见面 | 欢迎 + 引导逐个上传素材 | 素材上传完成 + 孩子开口 |
| S1 | 倾听+魔法反馈 | 孩子一口气讲完 → 魔法棒轻量动效"变出大树森林" → "我们听懂你的意思了"（开心反馈） | 讲述结束（素材+讲完） |
| S2 | 缺口推理 | `check_skeleton` 后台推理大框架缺什么（角色/场景/冲突/结尾） | 缺口清单生成 |
| S3 | 最少追问 | **只对缺口追问，上限 2 轮**，控制轮次不扯远不搞深 | 追问完毕（或已问 2 轮） |
| S4 | 概括确认 | 用孩子原话概括整个故事 → 最终确认/修正 | 孩子确认或修正后无异议 → 触发生成 |

- **策略是动态的**：孩子讲得多 → 倾听 + 补缺；讲得少/碎 → 回落引导兜底（三级降级）。
- **大框架完整优先于细节发散**：超过缺口上限时只问最关键的 1 个，其余默认"留白"进绘本。
- 阶段机**不在代码里**，存在于 agent state + 分阶段提示词里；`finishTurn` 钩子负责出口判定与阶段切换。
- **三级降级兜底**（任何阶段）：换问法（开放→半开）→ 给选项（结合前文）→ 保底"今天就到这"并存档进度。

### 3.5 五类问题模板（S3 缺口追问用）
骨架（补缺优先）：角色 / 场景 / 冲突(情节·起) / 结尾。
血肉（有余量才问）：情节·发展 / 情绪 / 细节。
> 缺口追问保证大框架完整（"过得去"）；轮次上限 2 轮保证不跑偏。

### 3.6 工具集（agent 可调用）
| name | 作用 | 时机 |
|---|---|---|
| `ingest_assets` | 素材入库 + NER + 半自动聚类 | S0-S1 素材管线 |
| `magic_render` | 魔法棒轻量动效反馈（具象化 + 开心反馈） | S1 |
| `save_story_element` | 把孩子回答结构化存库（`child_words`=孩子原话） | 每轮回答后 |
| `build_character_card` | 生成角色卡（主角从聚类中识别） | S2 |
| `check_skeleton` | 后台推理故事大框架缺口 | S2 |
| `save_book_title` | 存书名 | S4 生成前 |
| `start_book_generation` | 触发绘本生成（第 N 章） | S4 出口 |

- 系统层工具（不暴露给 agent）：`asr_transcribe`（讯飞 ASR）、`generate_book_page`（图生图）、`persist_session`。
- **安全红线**：`beforeToolCall` 钩子拦截一切非白名单工具调用（含 Pi 默认 bash 类，直接 block）。

### 3.7 数据表
**P0**：
`assets`（素材+NER标签）· `asset_clusters`（聚类：角色组/场景组/道具组）· `sessions` · `session_messages`(回放) · `story_elements` · `characters`(角色库，本地) · `book_characters`(多对多) · `books`(故事) · `chapters`(章节，含前情提要摘要) · `book_pages`(绘本页)

**P1**：`parent_summaries`(给家长的信)。

> 关键关系：`characters`（角色库，跨故事共享，不依赖单个 session）↔ `book_characters`（多对多）↔ `books` → `chapters`。

### 3.8 主导性验收口径（demo 可测）
- `book_pages.text_source='child_raw'` 占比 ≥ 60%；
- AI 新增情节数 = 0（`story_elements.element_type='plotbeat'` 且 `child_words` 为空的条数近似检查）。

### 3.9 人设 A/B（prompt 层）
- **A 琪琪老师**：知心姐姐，温柔鼓励型，描述性表扬。
- **B 动画伙伴**：聪明友好卡通角色，活泼夸张。**注意 B 的"喜羊羊"是注册商标，demo 可测，上线必须换原创形象。**

### 3.10 二次使用模块（P1，本期不做）
- **"我的故事集"工作台**（打开应用的第一层导航）：继续创作（续写某绘本下一章）/ 新的开始 / 我的角色们。
- **章节续写**：开**新 session** + 注入**前情提要摘要**（`chapters.preface`），不续旧 session。
- **新的开始**：可挑**老角色**（把角色卡作为 agent 上下文带入），也可**建新角色**（进角色库）。
- **角色库归属**：P0 用**设备本地角色库**（本地 SQLite 即角色库），账号化放 P2。
- **价值**：角色跨故事复用 = 孩子的长期 IP；章节续写 = 产品生命周期 / 留存钩子。

---

## 4. 代码质量（继承上游 + 本包补充）

- **erasable TypeScript**（Node strip-only）：无 `enum`/`namespace`/`module`/`import =`/`export =`/`parameter properties`。用字面量联合类型 + 显式构造字段。
- **无 `any`**，除非绝对必要；宁可显式类型。
- **顶层 import only**：禁 `await import()`、动态类型 import。
- **全量读文件再改**：宽泛改动前、编辑未完全检视的文件前、调研/审计时，完整读取，不依赖搜索片段。
- **不降级依赖修复 type error**：升级依赖而不是降级代码。
- **不删看似有意的代码**：删除前先确认，绝不静默移除。
- **依赖安全**：外部依赖精确锁版本；`npm install --ignore-scripts`；lockfile 变更当 reviewed code 对待。

---

## 5. 质量门与本地命令（本包专属）

命令在仓库根用 workspace 形式运行（PowerShell；也可在 `packages/kidmagic` 内直接 `npm run <script>`）：

- **类型检查**：`npm run check --workspace=@earendil-works/pi-kidmagic`（`tsgo --noEmit`，覆盖 src / scripts / test）。改码后必跑，零 error 才算过。
- **单元 + 冒烟测试**：`npm run test --workspace=@earendil-works/pi-kidmagic`（vitest，仅本包 test/）。本包测试**全部离线**（faux provider + 内存 SQLite，见 §8），不触网、不计费，改码后应常跑，新增/修改测试必须跑到通过。
- **构建**：`npm run build --workspace=@earendil-works/pi-kidmagic`（tsgo emit 到 `dist/`，仅 src）。改了对外导出、或运行时走 dist 联调前跑。
- **固定剧本 demo（真实模型、会计费）**：
  ```powershell
  $env:OPENROUTER_API_KEY = "sk-or-..."
  npm run demo --workspace=@earendil-works/pi-kidmagic
  ```
  默认模型 `google/gemini-2.5-flash`，可用 `OPENROUTER_MODEL`、`KIDMAGIC_PERSONA`（A/B）覆盖；在包目录生成 `kidmagic-demo.db`。逻辑正确性优先靠 §8 离线测试，demo 只用于真人/真模型抽检。
- 依赖的上游 Pi 包 `dist/` 被 gitignore；首次拉取或 dist 缺失时，按依赖链先构建上游包（telemetry→chord→ai→agent→sqlite-node），其中 ai 包需先 `npm run hydrate:model-data` 拉模型 catalog。
- 临时脚本放 `scripts/`，不把多行脚本内嵌进 shell 命令。

---

## 6. Git 纪律

- **只提交本会话自己改的文件**；`git add <明确路径>`，禁 `git add -A` / `git add .`。
- **禁止**：`git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git commit --no-verify`。
- **不 force push**；rebase 冲突只在**自己改过的文件**里解决，冲突在他文件则中止并询问。
- **commit 格式**：`{feat,fix,docs}(kidmagic): <信息>`。
- **跟随上游**：`git fetch upstream` + merge **release tag**（不跟 main）。因不碰 Pi 包，冲突面≈0；真冲突只会出现在本包 `package.json` 的依赖版本号。

---

## 7. Changelog

- 位置：本包 `CHANGELOG.md`。新条目一律进 `## [Unreleased]` 下的 `### Breaking Changes / ### Added / ### Changed / ### Fixed / ### Removed`，**只 append 不重复**。
- 已发布版本章节（如 `## [0.1.0]`）不可修改。
- 提交若关联 issue/PR，按上游格式标注（`[#123]` / `by @user`）。

---

## 8. 测试约定（本包）

- 测试在 `test/`，vitest，运行见 §5。**全部离线、确定性**：禁止真实网络与真实 API key；模型一律用 faux，数据库一律用内存库。
- faux provider 从 `@earendil-works/pi-ai/compat` 导入：`registerFauxProvider` / `fauxAssistantMessage` / `fauxToolCall`。
  - `const faux = registerFauxProvider()`；`faux.setResponses([...])` 按**模型被消费的顺序**排队；模型用 `faux.getModel()`；`afterEach` 里 `faux.unregister()`。
  - 工具调用回合：`fauxAssistantMessage([fauxToolCall(name, args), ...], { stopReason: "toolUse" })`；纯文本回复：`fauxAssistantMessage("...")`。
  - `finishTurn` 返回 `continue` 会在同一次 `agent.prompt` 内继续消费下一条响应——排队时按此预估条数。
  - 范本：`test/story-agent.smoke.test.ts`（S0→S4 闭环、缺口追问 2 轮上限、非白名单工具拦截）。
- 数据库：`openDatabase(":memory:")`，每个用例独立。
- 每条产品规则（阶段切换、工具约束、主导性口径、角色去重）都应有对应断言；`childRawRatio` 等验收口径范本见 `test/storage.test.ts`。

---

## 9. 二开协作与作品集定位

- 本包作为个人作品集的开源二开项目：README 须注明「Pi 能力 / 二开内容」；许可证 MIT，保留上游版权声明。
- 发现上游通用缺口 → 整理 issue/PR 回上游；**先跑通本产品，再为贡献而改上游**。
- 上游规范与本文件冲突时，以**不违背上游精神**、更贴合本包实际为准；重大偏离需向用户确认。

---

## 10. User Override

若用户指令与本文件任何规则冲突，先向用户明确确认，再执行覆盖。不静默违背本规范。
