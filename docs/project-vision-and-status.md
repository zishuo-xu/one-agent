# One Agent：目标、愿景与设计现状

> 文档状态：维护中的当前事实源
> 最后更新：2026-07-19
> 本文档是项目定位与架构现状的唯一长期总览。每次影响产品边界、运行时行为、数据结构或核心能力的修改，都应在同一个 Git commit 中同步更新本文档。

本文使用三种状态：**已实现**表示代码与验证均已存在，**部分实现**表示已有基础但边界有限，**候选方向**表示仅完成设计讨论、尚未进入 Runtime。

## 1. 项目定位

One Agent 是一个**模型无关、可靠性优先的轻量 Agent Runtime**，支持：

- 可控的工具执行；
- 简单任务直达、复杂任务规划的双 Loop；
- 长任务规划、失败处理与断点恢复；
- 任务中途澄清、关闭后恢复与继续；
- 跨会话记忆；
- 完整可信的 Trace；
- 基于 Trace、工具证据和 workspace 终态的离线 Eval。

One Agent 的目标不是复制 Claude Code 的全部产品体验，也不是依靠某个特定模型获得能力。项目重点研究的是：

> 当模型输出存在波动、工具可能失败、进程可能中断时，Agent Runtime 如何保持执行可控、过程可追踪、任务可恢复、结果可评测。

## 2. 核心愿景

### 2.1 模型可以替换，运行时能力不能消失

Agent 通过 `ModelProvider` 使用模型，并支持主备模型切换。当前 OpenAI Compatible Adapter 与原生
Anthropic Messages Adapter 都收敛到同一份内部消息、`name/description/inputSchema` 工具定义、工具调用、
流式块、Token 和错误契约；内部不再沿用任一厂商的工具 Schema。Provider 除了归一请求与响应，还声明流式输出、
工具调用、结构化输出、reasoning 和上下文窗口能力；Runtime 在创建 Agent 前校验硬要求，不能把模型品牌或
方法签名当作能力已经可用。规划、执行、工具控制、持久化、Trace 和 Eval 属于 Runtime，不绑定特定模型。

能力支持分为 `native`、`emulated`、`best_effort` 和 `unsupported`。硬要求只接受 Provider 能够保证的
native/emulated；Fallback Provider 取整条主备链的最弱共同能力，防止故障转移后静默失去工具调用等能力。
兼容网关未单独提供 `ANTHROPIC_API_KEY` 时可复用 `OPENAI_API_KEY`，避免同一凭据在配置中重复维护。
2026-07-19 已使用 `deepseek-v4-flash` 和 `https://api.deepseek.com/anthropic` 完成真实流式回答、
`get_time` 工具调用与 Trace 落库验证；Trace 中的 Provider 明确记录为 `anthropic`。

### 2.2 执行事实与评价结果分离

正常执行链只负责完成任务、记录事实并向用户返回。运行结束后不会同步追加自动验证、自动分析、自动修复或自动优化任务。

Completion Contract 只属于离线 Eval。Eval 失败不能反向把真实执行成功的 Run 改写成失败。

### 2.3 Trace 是事实记录，不是自动优化器

Runtime 完整记录模型调用、计划变化、工具执行和最终回复。开发人员使用 Trace Viewer 或其他工具分析问题，并自行决定如何改进 Agent。

### 2.4 可靠恢复优先于盲目重试

进程中断后，系统必须区分已完成步骤、安全重试操作和结果不确定的副作用操作。无法确认是否安全时，应停止自动恢复并明确暴露状态，而不是重复执行。

## 3. 明确的产品边界

当前不进入 Runtime 主链路的能力：

- 执行结束后的同步验证；
- 根据 Trace 自动修改 Prompt 或代码；
- 自动生成并应用 Agent 优化方案；
- 不受控制的多 Agent 递归；
- 对结果不确定的副作用工具进行盲目重放。

这些边界保证 One Agent 保持轻量，并让“执行”“观测”“评价”“人工改进”各自独立。

## 4. 当前运行时结构

```text
CLI / REST API
      │
      ▼
AgentRuntime（workspace 级装配：模型、工具、数据库、Store、记忆生命周期）
      │
      ▼
AgentLoop（Thread 级门面：记忆召回、策略选择、Run 生命周期）
      │
      ▼
RunContext（一次请求的 runId、signal、memory、reasoning、recovery）
      │
      ├── SimpleLoop：直接回答、常规工具循环
      └── PlanningLoop：计划、步骤执行、Judge、重试、重规划、恢复
      │
      ├── ModelCaller / ModelProvider
      │     ├── OpenAICompatibleProvider
      │     ├── AnthropicProvider
      │     └── FallbackProvider（允许跨协议主备）
      ├── ToolRunner ── ToolPolicy ── ToolExecutor / ToolRegistry / Sandbox
      ├── ContextManager / MemoryStore
      └── RunRecorder / SQLite

会话边界：MemoryConsolidator ── 整理完整 Thread 的用户消息

离线：EvalRunner ── Completion Contract ── Trace / workspace 终态
观察：Trace Viewer ── 只读取运行记录
```

核心概念保持五个：`AgentRuntime` 负责装配，`AgentLoop` 负责运行生命周期，Loop 负责决策，
`ToolRunner` 负责统一工具执行协议，`ToolPolicy` 是执行前授权规则的唯一所有者，`RunRecorder` 负责事实记录。`RunContext` 只是随一次请求传递的数据对象，
不是新的服务层。`AgentEvent` 是独立于 `AgentLoop` 的公共事实协议，因此 Memory、TaskQueue、Eval 和 UI
不需要反向依赖运行时门面。

`AgentLoop` 内部按一次 Run 的生命周期分为三个私有阶段，不增加新的服务层：

```text
prepareRun       → 请求上下文、Run 关联、起始 Trace
executeStrategy  → 审批继续、记忆召回、Loop 选择与执行
finalizeRun      → waiting/completed、Trace 收尾、Run 状态落库
```

异常统一由执行入口记录 `failed/cancelled` 并完成收尾。三个阶段共享同一个局部
`PreparedExecution` 数据对象，不持有跨 Run 状态，也不改变 SimpleLoop、PlanningLoop 或持久化层职责。

## 5. 正常执行流程

```text
用户请求
  → 创建 Run（traceStatus=recording）
  → 召回相关长期记忆并记录 memory_recall
  → 建立只属于本次请求的 RunContext
  → 选择 SimpleLoop 或 PlanningLoop
  → 执行模型调用；所有工具调用统一经过 ToolRunner
  → 持久化 Trace；需要恢复的节点写入 recovery_point
  → 信息充分：记录最终消息和 completed
  → 缺少关键输入：记录问题、recovery_point 和 waiting_for_input
  → 刷新 Trace 缓冲区
  → 立即向用户返回答案或待回答问题
```

隐含长期记忆的整理不在每轮回答链路中。它以完整 Thread 为单位，在切换会话或正常退出时处理刚离开的会话；Agent 启动时扫描尚未成功整理的会话并重试。整理失败不会阻塞回答，也不会把 Thread 误标为已完成。用户明确要求记住、修正、忘记或查询记忆时，当前主模型通过 `manage_memory` 工具立即操作，不增加第二次模型调用。

普通观察 Trace 写入失败不会改变任务结果，但 Run 会记录 `partial/failed`、丢失事件数量和错误原因。
`recovery_point` 是恢复所需的关键事实，写入失败时不能继续推进到新的可恢复状态。

### 5.1 Tool Policy：执行层的单一授权入口

所有 Runtime 工具调用统一经过 `ToolRunner → ToolPolicy → ToolExecutor`。危险性分类只存在于第五层
“能力执行层”，SimpleLoop、PlanningLoop、AgentLoop、CLI 和 API 都不能各自维护危险工具名单。

`ToolPolicy` 对一次冻结后的工具调用返回三种决定：`allow`、`deny` 或 `require_confirmation`。
默认策略允许普通工具，`delete_file` 和 `run_command` 需要用户确认；Runtime 使用工具名称与规范化参数生成
SHA-256 指纹。用户批准后执行的是恢复点中冻结的工具与参数，模型不能在批准之后替换路径、命令或参数。
拒绝时不会调用工具，也不会再调用模型。

审批复用第三层已经存在的持久化等待协议，但第三层不判断工具风险：执行层只向上返回
`tool_approval` 请求，AgentLoop 仍只负责 `waiting_for_input` 生命周期。CLI/API 只展示决定，SQLite 只保存
执行事实，因此授权规则仍然只有一个所有者。非交互式 TaskQueue 和子 Agent 不启用默认审批策略。

CLI 默认只向用户流式展示 `message_delta`。模型 `reasoning_delta` 始终写入 Trace，只有显式启用
`--verbose` 时才在独立的 `[reasoning]` 区域展示，不能进入最终回复内容或回答耗时。
`/context` 默认只展示用户消息与最终回复；内部工具消息仅在 `/context --verbose` 中显示。

CLI 已归一为一个默认启动路径：`one-agent` 恢复最近 Thread（不存在则新建）并使用 `auto` Loop；
`--new` / `--thread` 只决定会话，`--loop auto|simple|planning` 只决定执行策略，`--verbose` 只决定展示。
`--new` 与 `--thread` 互斥，指定 Thread 不存在时明确失败，不再隐式创建指定 ID 的会话。
只读观察服务使用独立的 `one-agent trace` 命令，启动时不要求模型 API Key。旧 `--plan`、`--plan-auto`、
`--trace` 暂时保留兼容并给出废弃提示，不再作为主要使用方式。

### 5.2 Strategy Controller：决策层的安全动态升级

Auto Planning 不再只依赖 Run 开始前的一次分类。分类器判断 `direct` 后，SimpleLoop 会在首批工具真正执行前
把工具数量作为运行时信号交给 `StrategyController`：首批一到两个工具继续直接执行；首批出现三个以上工具时升级到
PlanningLoop。切换发生在任何工具副作用之前，因此不会重复执行已经完成的操作。

分类器采用成本敏感边界：对话、记忆召回、简短回答和一到两个独立操作优先 `direct`；只有明确存在依赖执行、
协调修改、验证/恢复或需要拆解的任务才提前进入 PlanningLoop。分类器负责提前识别真正复杂的任务，
StrategyController 负责用首次真实工具批次纠正低估，避免简单任务支付完整规划税。

V1 只允许 `simple → planning`、最多一次，并记录 `strategy_switch` Trace，包含原因、工具名称、迭代位置和
已使用切换次数。已经开始工具执行、强制 Simple/Planning、恢复中的 Run 和 `request_user_input` 不参与动态切换。
控制器属于第四层决策层；CLI 只展示切换，Trace Viewer 只读取事件，工具执行层和持久化结构不理解切换规则。

## 6. Trace 设计现状

Trace 使用 `run_id + sequence` 保持单次运行内的稳定顺序，当前事件包括：

- `run`：开始、完成、失败、取消和恢复来源；
- `model_call`：主模型、分类器、Planner、Judge、摘要模型的开始、结束、耗时、重试和 token；
- `plan` / `plan_step`：计划和步骤状态变化；
- `strategy_switch`：Auto 模式在工具执行前从 SimpleLoop 安全升级到 PlanningLoop；
- `tool_call` / `tool_result`：工具、参数、关联 ID、步骤、状态和耗时；
- `tool_policy`：执行层对工具调用的允许、拒绝、等待确认及批准恢复；
- `thought` / `reflection`：Runtime 可见的规划执行信息；
- `message_delta` / `reasoning_delta` / `message`；
- `sub_agent`：受限子 Agent 的生命周期与压缩事件流；
- `memory_recall`：候选记忆、命中依据、过滤原因、最终注入 ID 和上下文成本；
- `memory_consolidation`：会话级记忆整理的开始、完成或失败。
- `input_required` / `input_received`：中途澄清问题及后续回答的恢复关联；
- `recovery_point`：计划、执行位置、等待问题和未完成工具等恢复所需的完整状态。

流式增量在落库时聚合，避免逐 token 写入。恢复点在数据库内部保留精确参数，Trace 查询与 Viewer
仍按 `TRACE_CONTENT` 执行脱敏；默认值为 `redacted`，也支持 `metadata` 和 `full`。

### 6.1 Trace Viewer 人工分析入口

Trace Viewer 保持只读，不触发验证、恢复或重新执行。当前可以：

- 按 Thread、Run 查看完整有序时间线，并按事件类型筛选；
- 展开事件原始 JSON，查看子 Agent 的压缩内部事件流；
- 在 Run 总览中查看运行状态、Trace 健康度、耗时、token、模型/工具调用、重试和事件数量；
- 标记模型或工具失败、Trace 丢失等异常指标；
- 关联并跳转中断 Run、来源 Run 和后续恢复 Run。

总览指标由 Trace 与 `agent_runs` 即时汇总，不增加统计表，不写回运行状态，也不影响 Agent 返回时延。

## 7. Trace 驱动的断点恢复

断点恢复不再维护独立的运行时存档。正常执行只在现有 `trace_events` 中写入有序的
`recovery_point`，内容包括：

- 原始任务；
- 当前计划及步骤状态；
- 当前执行单元；
- retry/replan 次数；
- 恢复次数和来源 Run；
- 执行中的工具及其恢复策略。

只有 `/resume` 或提交等待问题答案时，系统才按 `sequence` 读取该 Run 最后一条恢复点并继续。
这段读取逻辑是恢复入口中的简单函数，不存在持续运行的 Checkpoint 组件，也不新增数据库表。
`agent_runs.checkpoint` 仅作为旧版本 Run 的兼容字段：新 Run 不再写入；旧 Run 没有
`recovery_point` 时才回退读取该字段。

数据边界保持单一：`RunStore` 只查询和更新 `agent_runs`，不理解 Trace 结构；
`TraceEventStore.getLatestRecoveryPoint()` 只负责读取恢复事实；`AgentLoop` 的 `resume/continue`
入口组合两者并执行 Trace-first、旧字段回退。CLI 的恢复提示同样显式读取恢复点，普通 Run 查询不会解析日志。

CLI 启动后会提示当前会话中的可恢复 PlanningLoop Run。用户使用 `/resume <run-id>` 创建新 Run 并继续执行：

- 已完成步骤跳过；
- `read_file`、`list_files`、`search_files`、`web_search`、`get_time` 可以安全重试；
- 写入、追加、删除、命令执行等不确定副作用进入 `recovery_required`；
- 单个任务最多恢复三次。

当前恢复是显式触发，不会在启动时擅自恢复，避免把仍由其他进程执行的 Run 当成僵死任务。

### 7.1 真实进程故障注入评测

恢复能力不只使用内存内模拟测试。`pnpm eval:recovery` 会构建 agent-core，启动独立 Node 子进程，
等待 Trace 出现指定恢复点后发送 `SIGKILL`，再由另一个 Node 进程读取同一 SQLite 数据库恢复。

当前覆盖三类真实中断：

1. 步骤模型调用中断：旧 Run 变为 `interrupted`，新 Run 从未完成步骤继续，并在 Trace 中记录来源；
2. `read_file` 执行中断：恢复前补齐旧历史中孤立的 tool-call/result 配对，然后安全重试；
3. `write_file` 已产生文件副作用但尚未返回：恢复被拒绝，Run 进入 `recovery_required`，文件只写入一次。

恢复评测 v1 当前为 3/3 通过，报告见 `eval-results/2026-07-18-recovery-eval-v1.md`。

### 7.2 持久化中途询问

当主 Agent 缺少一个无法安全假设的关键信息时，可调用 `request_user_input`。该工具只用于澄清，
不承担危险操作审批，也不允许与其他工具调用混在同一批次执行。

系统不会让进程原地阻塞。SimpleLoop 和 PlanningLoop 都返回统一的 `waiting_for_input` 结果，
并把问题与恢复位置写入同一条有序 Trace；当前 Run 随即结束执行并返回用户。CLI 关闭后，
下次打开同一 Thread 会重新显示问题。用户直接输入答案会原子领取等待 Run、创建一个新 Run 并继续；
`/cancel` 会把旧 Run 标为 `cancelled`。同一个等待 Run 不能被重复继续。

REST API 的 `/api/chat` 同样返回 `status`、`runId` 和 `inputRequest`；调用
`POST /api/runs/:id/input` 提交答案，或 `POST /api/runs/:id/cancel` 取消。非交互式 TaskQueue
明确不注册该工具，避免把等待问题误判为后台任务完成。

这一能力没有新增数据库表：`agent_runs.status` 使用 `waiting_for_input`，恢复点使用
`loopMode` 区分 SimpleLoop 与 PlanningLoop。Trace 只记录事实，不会在询问后触发自动验证或优化。

同一等待协议也承载执行层发出的 `tool_approval`，但两种功能的所有权保持分离：模型澄清由决策层发起，
工具授权由 `ToolPolicy` 决定，AgentLoop 只管理它们共同的等待生命周期。

## 8. SQLite 数据结构

当前保持七张业务表：

| 表 | 职责 |
|---|---|
| `threads` | 会话 |
| `messages` | 对话消息及用户可见/内部消息标记 |
| `agent_runs` | 一次执行、生命周期和 Trace 健康度；保留旧 Checkpoint 字段用于兼容 |
| `trace_events` | 不可修改的执行事件历史，也是新 Run 的唯一恢复事实来源 |
| `tool_calls` | 已完成工具调用的最终凭证 |
| `tasks` | REST API 异步任务队列 |
| `memories` | 长期记忆事实、来源、作用域、置信度和生命周期 |

设计原则：经常查询和关联的字段结构化存储，变化频繁的 Plan 与恢复事实统一使用 Trace 的 JSON TEXT。
`messages.internal` 会随消息持久化，确保 CLI 重启后 `/history` 和默认 `/context` 仍不会泄露工具结果或内部步骤提示；
旧数据库中的历史消息还会根据 tool-call 结构和内部步骤前缀进行兼容过滤。

## 9. Eval 现状

能力评测集包含 40 个任务、77 个 checkpoint，并支持任务级并发。当前真实模型 v2 基线：

| Loop | 通过率 | Checkpoint | Tokens |
|---|---:|---:|---:|
| SimpleLoop | 35/40 | 71/77 | 约 420k |
| PlanningLoop | 29/40 | 61/77 | 约 697k |

结论是 PlanningLoop 不适合所有任务，但对多步协调、自我校验型任务有真实价值。因此 Runtime 保留 Simple、Planning 和 Auto Planning 三种模式，而不是强制所有任务规划。

Eval 的 Completion Contract 根据工具证据、文件条件和最终回答离线判分，不参与 CLI/API 的正常返回路径。

## 10. 记忆现状

当前能力：

- 以完整 Thread 为整理单位，Memory Agent 只从用户消息中提取长期事实；
- 每个候选必须返回原始消息 ID、逐字证据和证据中实际出现的最小事实值；无法由用户原文证明的候选直接丢弃，问题不能被当作答案来源；
- 切换或退出时只整理当前离开的 Thread，启动时恢复所有未成功整理的 Thread；
- `threads.memory_extracted` 使用单一布尔状态区分已提取/未提取，合法空结果也视为成功；
- 主 Agent 的每轮回答不调用记忆模型，整理失败不影响正常回答并可在下次启动重试；
- 用户可通过自然语言明确要求 `remember`、`correct`、`forget`、`inspect`，主模型只在显式意图下调用 `manage_memory`；
- 主动记忆在当前工具循环中立即生效，不额外调用提取模型，子 Agent 不继承记忆管理权限；
- 整理前把当前有效记忆交给 Memory Agent 避免语义重复；已有显式记忆优先，运行时拒绝其覆盖范围内的隐式重复候选；
- 用户消息、未提取状态和会话版本原子更新，整理期间新增消息时不会误标为已完成；
- 每条记忆关联原始 `source_message_id`，通过消息时间 `observed_at` 判断事实新旧；
- `global` 记忆跨 Thread 召回，`thread` 记忆只在所属 Thread 召回；
- 中英文关键词及中文 bigram 检索；
- 记忆整理不进入每轮用户回复主链路；
- 每条记忆包含置信度、`active` / `superseded` / `expired` / `forgotten` 状态、可选过期时间和最近召回时间；
- 同作用域同名事实采用确定性冲突策略：同值增强，较晚用户事实替代较早事实，晚处理的旧会话只能成为历史；
- 主动遗忘清除原值并保留带 `observedAt` 的墓碑；旧 Thread 延迟提取不能复活该事实，之后更新的显式指令仍可重新建立；
- `manage_memory` 拒绝保存密码、API Key、Token、Secret 等凭据型记忆；
- 每轮召回将候选、命中关键词、过滤原因、最终注入项和估算 token 写入 `memory_recall` Trace，且不复制记忆值；
- 每轮先清空旧记忆上下文，无关问题不会继承上一轮命中的记忆；
- `memory-recall-v1` 离线评测包含 6 个场景，覆盖中英文、误召回、作用域、状态过滤和排序；
- CLI 可列出、查看和精确删除记忆，API 可创建、查询、更新和删除记忆；对话中可立即管理记忆。

记忆治理保持单张 `memories` 表，只在 `threads` 增加提取状态，没有引入候选表、任务表、向量数据库、自动反思或自动优化 Agent。
Memory Consolidation 与 Memory Recall 均已写入 Trace。检索排序仍是关键词匹配加显式程度、置信度和事实时间，
而非语义向量检索；是否升级由后续扩充的评测集决定。

## 11. 当前能力地图

| 能力面 | 当前状态 | 实现边界 |
|---|---|---|
| 模型抽象 | 已实现 | OpenAI Compatible 与原生 Anthropic Adapter、共用 Provider 契约测试、创建前能力校验、跨协议主备链与 utility model |
| 模型诊断 | 已实现 | `one-agent doctor` 独立探测每个主备 Provider 的凭据状态、连接、流式和工具调用；不创建 Run/Trace，不进入 AgentLoop |
| 执行策略 | 已实现 | Simple、Planning、Auto Planning；Auto 可在首批超过两个工具时于执行前安全升级一次 |
| 规划与纠错 | 已实现 | 分层计划、步骤绑定、Judge、重试、重规划、并行波次 |
| 工具执行 | 已实现 | workspace 沙箱、参数校验、超时、危险命令拦截、Tool Policy 和冻结参数审批 |
| 子 Agent | 已实现 | 受限的浅层委派与只读并行，不允许递归扩张 |
| 上下文管理 | 已实现 | token 预算、滑动窗口、摘要、内部消息隔离 |
| 长期记忆 | 已实现 | 会话级整理、显式即时管理、遗忘墓碑、来源证据、冲突处理与关键词召回 |
| 运行中工作状态 | 部分实现 | RunContext 统一一次请求的关联信息；Plan 是 Loop 内状态，恢复点只是关键 Trace，不再维护第二份存档 |
| 中断恢复 | 部分实现 | PlanningLoop 和安全只读操作可恢复，副作用操作保守停止 |
| 中途澄清 | 已实现 | Simple/Planning 统一等待结果，CLI/API 可回答或取消，关闭进程后仍可继续 |
| 可观测性 | 已实现 | 完整 Trace、只读 Trace Viewer、记忆召回与整理事件 |
| 离线评价 | 已实现 | Completion Contract、能力评测、恢复故障注入评测 |
| 多模态输入 | 未实现 | 当前只处理文本消息和工具观察结果 |
| Skills / MCP | 未实现 | 当前工具在 Runtime 内静态注册，没有通用外部能力协议 |
| 运行中动态策略切换 | 部分实现 | StrategyController v1 支持执行前 simple→planning；尚不根据工具结果、不确定性或剩余预算继续切换 |

这张表用于区分“已经能演示的能力”和“适合继续研究的 Agent 课题”，避免路线图把设计设想写成产品事实。

## 12. 已知限制

- 原生 Anthropic Adapter 当前覆盖文本、工具调用、工具结果、流式输出、Thinking 内容块与 Token 用量；多模态内容块和 Anthropic 服务端工具尚未映射；
- `jsonMode` 在 Anthropic Adapter 中仍是提示词约束，因此只声明 `best_effort`，尚未引入带 JSON Schema 的统一结构化输出契约；
- OpenAI 兼容端点的工具能力由 Adapter 声明，尚未提供启动时的网络探测；错误声明会在真实调用时由端点返回错误；
- `write_file` 中断后尚未自动核对目标文件内容，v1 会保守地要求人工处理；
- `append_file`、`delete_file`、`run_command` 等副作用工具不自动恢复；
- 异常崩溃的 `/resume` 仍只覆盖 PlanningLoop；REST API 暂未提供异常崩溃恢复端点；
- 模型中途询问仍只处理关键澄清；危险工具审批由独立 Tool Policy 发起，两者都不支持多人审批或超时策略；
- Tool Policy 默认仅要求确认 `delete_file` 和 `run_command`；尚未提供 CLI 规则编辑、多人审批、审批超时或按命令语义细分风险；
- SQLite 迁移仍使用兼容式列检查，后续可增加版本化 `schema_migrations`；
- `tasks.events`、`reasoning_chain` 与 Trace 仍存在部分信息重复；Run 恢复已经以 Trace 为唯一新事实来源；
- 长期记忆仍是关键词检索模型，当前评测集尚未覆盖模型提取准确率和大规模记忆库性能。
- Memory Agent 目前依赖模型返回严格 JSON；真实模型返回多个代码块或畸形 JSON 时，整理会失败并留待下次启动重试，尚未实现结构化输出约束或安全修复解析。

## 13. 下一阶段方向

### 13.1 已确认的工程方向

1. 恢复 v2：为 `write_file` 增加目标内容或哈希核对，在确认结果后跳过或安全重试；
2. 扩展故障注入点，覆盖多步骤、重规划、连续恢复上限和进程启动阶段；
3. 扩充记忆评测：加入模型提取准确率、事实更新、多轮噪声和大规模候选性能；
4. 提升 Memory Agent 结构化输出的容错能力，同时保持失败可重试、不影响回答的边界；
5. 继续消除 `tasks.events`、`reasoning_chain` 等剩余重复状态来源，强化数据库迁移和状态约束；
6. 继续增强 Trace Viewer 的人工分析能力：工具调用配对、事件搜索、慢步骤定位与导出。

当前架构收敛原则：只提取跨 Loop 的真实重复协议和可独立测试的纯函数，不引入 DI 框架、通用工作流引擎、
每表 Repository 接口或尚无第三个实现的插件系统。

### 13.2 通用 Agent 能力后续研究

当前讨论形成了一个比新增业务工具更通用的研究方向：让 Agent 显式维护运行中的任务状态，并根据任务进展选择执行策略。

当前分两部分：

1. **WorkingState / Blackboard**：统一保存目标、约束、带证据的已知事实、待验证假设、未解决问题、已完成工作、失败尝试和下一步意图。它只记录可检查的结构化决策状态，不要求保存或展示模型的隐藏思维过程；
2. **Strategy Controller / AdaptiveStrategy**：V1 已实现首批超过两个工具触发的安全 `simple→planning`，并写入 Trace、限制最多一次。根据工具反馈、不确定性和剩余预算继续选择策略仍属于候选方向。

V1 不引入 WorkingState，因为“首批多工具”是切换前即可观察的安全信号。更深的运行中切换必须先有可靠、可检查的状态输入，否则策略控制器会变成另一层不透明模型路由。

## 14. 文档与提交约定

以后每次修改遵循：

1. 实现并验证功能；
2. 更新本文档中受影响的定位、设计、现状或限制；
3. 使用清晰的 Git commit 标题和详细正文，正文说明动机、设计、行为变化、验证结果与限制；
4. 推送到 GitHub；
5. 不提交密钥、用户数据、运行数据库、WAL、日志或评测任务生成的临时文件。
