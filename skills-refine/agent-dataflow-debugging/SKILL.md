---
name: agent-dataflow-debugging
description: "Agent 系统（含多模块、富模态输入的二开/生产环境）出现'数据没抵达它该抵达的地方'——素材/世界状态/上下文在对话里读不到、回复脱离用户输入、注入不生效、跨模块读不到刚写入的值——时，定位数据流断点并给出可验证修复。"
---

# Agent 数据流断点排查（可执行规范）

## Trigger / When to Use

在以下**任一**现象出现时启用本 Skill：

- agent 的上下文里缺它本应拥有的数据（上传了图，agent 还问"长什么样"；续写后不知道前文设定）。
- 一个模块写入的值，另一个模块读不到 / 读到空 / 读到旧值。
- 注入、装配、世界状态"看起来应该生效"但没有生效，且无报错。
- 生成或回复脱离用户刚提供的输入/素材。

不用于：模型回复质量本身、提示词效果、纯前端样式、无跨模块数据流的单点 bug。

## Goal

用可复现步骤定位"数据流断点"并产出可验证的修复，**在改任何代码前先给出证据**，不凭猜测重构。

## Workflow

按序执行；每步的"输入"即上一步输出。**每步完成后记录观察值，供下一步使用。**

### Step 1 · 列出目标数据的生命周期

- 输入：故障现象（哪条数据、期望到哪、实际到哪）。
- 动作：列出该数据从**产生**到**被消费**的全部环节：producer（写入方）→ 存储（persistence）→ consumer（读取方）→ context assembly（装配进 agent）→ model payload（真正发给模型的消息）。
- 产出：5 个环节清单，每个环节标注**代码位置**（文件 + 函数/路由）。

### Step 2 · 确认 producer 真的写入（含写入的 key）

- 输入：Step 1 的 producer 位置。
- 搜索：该写入调用的插入/更新 SQL 或 API，核对它用的**标识字段**（`session_id` / `book_id` / `context_id` / `world`）。
- 判断：写入是否真的执行？写入的 key 是哪个？值是空还是非空？
- 证据：能打印该 key 的日志行，或一条返回该记录的查询。
- 现象→动作：
  - 写入根本没执行 → 断点在 producer 之前（未触发/被过滤），停在这里。
  - 写入执行但值为空 → 断点在 producer 的取数/解析，停在这里。
  - 写入成功且值非空 → 进入 Step 3。

### Step 3 · 追踪 key 是否与 consumer 一致

- 输入：Step 2 确认的 producer key。
- 搜索：consumer 读取用的标识字段；重点核对**续写 / 二次进入 / 新建子会话**路径——业务实体（如 `bookId`）与执行会话（如 `sessionId`）常在此分离。
- 判断：producer 写入 key 与 consumer 读取 key 是否同一值？
- 证据：两端 key 的实际值（日志打印，或查询）。
- 现象→动作：
  - 两端 key 不同 → **这是最高频断点**。修正使两端使用同一"执行上下文 key"，停在这里。
  - 两端 key 相同 → 进入 Step 4。

### Step 4 · 确认 persistence 真的存下了（重启/重读不丢）

- 输入：Step 3 的 key（若 key 一致）。
- 搜索：存储表/缓存的 schema 与插入、读取语句；确认读取不依赖内存态而丢失的数据。
- 判断：读到的值是否等于写入时的值？重启后是否仍可读？
- 证据：读回查询返回与写入一致。
- 现象→动作：
  - 读回为空 / 不一致 → 断点在存储层（迁移缺失、列未建、双写不一致），停在这里。
  - 读回一致 → 进入 Step 5。

### Step 5 · 检查 context assembly（注入是否真把数据放进 agent）

- 输入：Step 4 确认存在的数据。
- 搜索：注入 / 装配代码（关键字 `inject`、`system message`、`messages[0]`、`context`）。
- 判断：注入是否执行？注入文本内容是否包含目标数据？
- **专门检查静默失败点**：对消息结构做**类型假设**（如 `content` 必须是数组 / 必须是字符串）且假设不符直接 `return`；`if(!x) return` 式空值早退。
- 证据：注入函数打印"类型 + 是否命中 + 注入文本前 200 字符"。
- 现象→动作：
  - 注入未执行 / 静默 return → 补显式日志使其可见，修正类型/空值处理，停在这里。
  - 注入执行但文本缺目标数据 → 断点在 Step 2-4，回查。
  - 注入文本含目标数据 → 进入 Step 6。

### Step 6 · 检查实际 model payload（数据是否真的发给模型）

- 输入：Step 5 确认注入成功。
- 搜索：真正组装发给模型的消息数组（model payload），确认注入文本确实进入该数组且未被截断/覆盖/放错角色。
- 判断：模型收到的 messages 中是否含该数据？
- 证据：打印 payload 中 system/user 消息的实际内容。
- 现象→动作：
  - payload 里没有 → 装配层又丢了一次，回到 Step 5。
  - payload 里有但模型不遵循 → 属"注入≠遵循"，改用"agent 主动取世界状态"机制（如 `get_world_state` 工具），不在本 Skill 强改 prompt。

## Search Patterns

用以下**代码检索关键词 / 模式**定位各环节（grep，跨模块）：

| 环节 | 检索关键词 / 模式 |
|---|---|
| producer | `session_id` `book_id` `insertInto` `INSERT INTO` `upsert` `writeImage` `saveRemoteImage` |
| key 追踪 | `sessionId` `bookId` `context_id` `session_id` `book.session_id`（注意与当前执行会话是否一致） |
| persistence | `schema` `CREATE TABLE` `ALTER TABLE` `migrate` `PRAGMA table_info` `WHERE session_id` |
| context assembly | `inject` `asset-context` `world-state` `messages[0]` `system` `content`（string vs array 类型分支） |
| consumer | `get_world_state` `listAssets` `listClusters` `WHERE session_id` `WHERE book_id` |
| model payload | `prompt(` `messages` `assistantText` `streamSimple` `payload` |

检索后，把**每个检索命中的代码位置**记录进 Step 1 的环节清单。

## Decision Rules（决策树）

按以下顺序判定；命中即停，不跳步。

```
读不到数据
├─ 先确认 producer：写入是否执行？
│   ├─ 否 → 断点在触发/过滤，修触发条件
│   └─ 是（且值非空）
│       └─ 追踪 key：producer key == consumer key？
│           ├─ 否 → 断点=key 错位（最高频），统一两端"执行上下文 key"
│           └─ 是
│               └─ 确认 persistence：读回 == 写入？
│                   ├─ 否 → 断点=存储层（迁移/列/双写）
│                   └─ 是
│                       └─ 检查 context assembly：注入执行且含数据？
│                           ├─ 否 → 断点=静默失败/注入未装配，补可见日志修
│                           └─ 是
│                               └─ 检查 model payload：数据进入发给模型的 messages？
│                                   ├─ 否 → 装配层二次丢失，回 context assembly
│                                   └─ 是 → 数据已抵达；若模型仍不遵循，属"注入≠遵循"，改用 agent 主动取世界状态
```

每到一个"断点="，即进入 Step 7 修复与 Output Format。

## Step 7 · 修复 + Evidence Requirements

**修改任何代码前**，先陈述并记录以下证据（缺一不可，避免凭猜测重构）：

- **producer**：谁写、写入的 key、写入值（代码行 + 日志/查询证据）。
- **key**：producer 与 consumer 的实际 key 值。
- **consumer**：谁读、读取的 key、读到的值。
- **断点**：基于上面证据定位到哪个环节（可对应决策树节点）。
- **运行证据**：触发一次该路径的日志/查询结果，而非仅代码阅读。

证据齐备后才做最小改动；改动必须只针对断点环节。

## Verification

修复后按以下方式验证，全部通过才算完成：

1. 复跑 Step 2-6 的触发路径，确认读回值 = 期望值。
2. 链路日志显示 producer key 与 consumer key 一致。
3. 注入文本实际包含目标数据（打印验证）。
4. 端到端：agent 回复 / 产物中出现该数据应有的体现。

## Regression Test

把本次断点固化为可执行测试，至少覆盖：

- 同一数据在"producer 写入 → consumer 读取"下往返一致。
- **静默失败防御**：消息 `content` 为 string 与为 array 时，注入都成功（不 return）。
- 空值 / 缺数据分支**必须产生日志**（不静默吞）。
- key 错位场景：续写/二次进入后，两端 key 保持一致。

## Output Format

完成排查后，统一按以下结构输出（无论口头或写入文档）：

```
Root Cause    ：一句话断点结论（对应决策树节点）
Evidence      ：producer / key / consumer / 断点 / 运行证据各一句 + 代码行或日志
Data Flow     ：产生 → 存储 → 读取 → 装配 → payload 的实际流转（含两端 key）
Fix           ：对断点环节的最小改动
Regression Test：新增/修改的测试名及断言
Remaining Risks：未覆盖场景 / 后续需观察项（如富模态信息损失、注入≠遵循）
```

## Checklist

- [ ] 已列出数据生命周期全部环节并标注代码位置。
- [ ] producer 写入值非空且有日志/查询证据。
- [ ] 已核对 producer 与 consumer 的 key，确认一致（尤其续写/二次进入路径）。
- [ ] 已排除存储层（读回 = 写入）。
- [ ] 注入执行且文本含目标数据（已打印验证）。
- [ ] 已确认数据进入实际发给模型的 payload。
- [ ] 改代码前已给出 producer/key/consumer/断点/运行证据。
- [ ] 已补链路日志含 key。
- [ ] 已固化为回归测试（含 string/array 注入、空值打日志）。
- [ ] 已按 Output Format 输出结果。

## Example（案例，非通用根因）

某儿童 AI 绘本二开：上传画作 → 视觉理解 → 应注入 agent 上下文，但 agent 仍问"鸟长什么样"。
- 该案例中，断点组合为：续写后 `book.session_id`（业务实体）与执行会话 `sessionId` 分离导致**key 错位**；且注入函数假设 `content` 为数组而实际为字符串导致**静默失败**。
- 修复：链路统一用"执行会话 key"；注入兼容 string/array 并补显式日志。
- 此案例展示的是"两种断点类型如何组合"，**不代表所有 agent 数据流问题都含 key 错位**；每个新问题必须从 Step 1 独立定位。
