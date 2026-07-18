# One Agent：目标、愿景与设计现状

> 最后更新：2026-07-18
> 本文档是项目定位与架构现状的唯一长期总览。每次影响产品边界、运行时行为、数据结构或核心能力的修改，都应在同一个 Git commit 中同步更新本文档。

## 1. 项目定位

One Agent 是一个**模型无关、可靠性优先的轻量 Agent Runtime**，支持：

- 可控的工具执行；
- 简单任务直达、复杂任务规划的双 Loop；
- 长任务规划、失败处理与断点恢复；
- 跨会话记忆；
- 完整可信的 Trace；
- 基于 Trace、工具证据和 workspace 终态的离线 Eval。

One Agent 的目标不是复制 Claude Code 的全部产品体验，也不是依靠某个特定模型获得能力。项目重点研究的是：

> 当模型输出存在波动、工具可能失败、进程可能中断时，Agent Runtime 如何保持执行可控、过程可追踪、任务可恢复、结果可评测。

## 2. 核心愿景

### 2.1 模型可以替换，运行时能力不能消失

Agent 通过 `ModelProvider` 使用 OpenAI 兼容模型，并支持主备模型切换。规划、执行、工具控制、持久化、Trace 和 Eval 属于 Runtime，不绑定特定模型。

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
AgentLoop（装配与一次运行生命周期）
      │
      ├── SimpleLoop：直接回答、常规工具循环
      └── PlanningLoop：计划、步骤执行、Judge、重试、重规划、恢复
              │
              ├── ModelCaller / ModelProvider
              ├── ToolRegistry / ToolExecutor / Sandbox
              ├── ContextManager / MemoryStore
              └── RunRecorder / SQLite

离线：EvalRunner ── Completion Contract ── Trace / workspace 终态
观察：Trace Viewer ── 只读取运行记录
```

## 5. 正常执行流程

```text
用户请求
  → 创建 Run（traceStatus=recording）
  → 选择 SimpleLoop 或 PlanningLoop
  → 执行模型与工具调用
  → 持久化 Trace；PlanningLoop 同时更新 Checkpoint
  → 记录最终消息和 Run 状态
  → 刷新 Trace 缓冲区
  → 立即向用户返回
  → 后台执行非阻塞记忆抽取
```

Trace 写入失败不会改变任务结果，但 Run 会记录 `partial/failed`、丢失事件数量和错误原因。

CLI 默认只向用户流式展示 `message_delta`。模型 `reasoning_delta` 始终写入 Trace，只有显式启用
`--verbose` 时才在独立的 `[reasoning]` 区域展示，不能进入最终回复内容或回答耗时。
`/context` 默认只展示用户消息与最终回复；内部工具消息仅在 `/context --verbose` 中显示。

## 6. Trace 设计现状

Trace 使用 `run_id + sequence` 保持单次运行内的稳定顺序，当前事件包括：

- `run`：开始、完成、失败、取消和恢复来源；
- `model_call`：主模型、分类器、Planner、Judge、摘要模型的开始、结束、耗时、重试和 token；
- `plan` / `plan_step`：计划和步骤状态变化；
- `tool_call` / `tool_result`：工具、参数、关联 ID、步骤、状态和耗时；
- `thought` / `reflection`：Runtime 可见的规划执行信息；
- `message_delta` / `reasoning_delta` / `message`；
- `sub_agent`：受限子 Agent 的生命周期与压缩事件流。

流式增量在落库时聚合，避免逐 token 写入。默认 `TRACE_CONTENT=redacted`，也支持 `metadata` 和 `full`。

### 6.1 Trace Viewer 人工分析入口

Trace Viewer 保持只读，不触发验证、恢复或重新执行。当前可以：

- 按 Thread、Run 查看完整有序时间线，并按事件类型筛选；
- 展开事件原始 JSON，查看子 Agent 的压缩内部事件流；
- 在 Run 总览中查看运行状态、Trace 健康度、耗时、token、模型/工具调用、重试和事件数量；
- 标记模型或工具失败、Trace 丢失等异常指标；
- 关联并跳转中断 Run、来源 Run 和后续恢复 Run。

总览指标由 Trace 与 `agent_runs` 即时汇总，不增加统计表，不写回运行状态，也不影响 Agent 返回时延。

## 7. 断点恢复 v1

为了保持数据库简单，断点恢复没有增加业务表，只在 `agent_runs` 中增加：

```sql
checkpoint TEXT
```

Checkpoint 是一份 JSON 最新状态，保存：

- 原始任务；
- 当前计划及步骤状态；
- 当前执行单元；
- retry/replan 次数；
- 恢复次数和来源 Run；
- 执行中的工具及其恢复策略。

Trace 是不可修改的历史，Checkpoint 是不断覆盖的最新存档。

CLI 启动后会提示当前会话中的可恢复 PlanningLoop Run。用户使用 `/resume <run-id>` 创建新 Run 并继续执行：

- 已完成步骤跳过；
- `read_file`、`list_files`、`search_files`、`web_search`、`get_time` 可以安全重试；
- 写入、追加、删除、命令执行等不确定副作用进入 `recovery_required`；
- 单个任务最多恢复三次。

当前恢复是显式触发，不会在启动时擅自恢复，避免把仍由其他进程执行的 Run 当成僵死任务。

### 7.1 真实进程故障注入评测

恢复能力不只使用内存内模拟测试。`pnpm eval:recovery` 会构建 agent-core，启动独立 Node 子进程，
等待数据库出现指定 Checkpoint 后发送 `SIGKILL`，再由另一个 Node 进程读取同一 SQLite 数据库恢复。

当前覆盖三类真实中断：

1. 步骤模型调用中断：旧 Run 变为 `interrupted`，新 Run 从未完成步骤继续，并在 Trace 中记录来源；
2. `read_file` 执行中断：恢复前补齐旧历史中孤立的 tool-call/result 配对，然后安全重试；
3. `write_file` 已产生文件副作用但尚未返回：恢复被拒绝，Run 进入 `recovery_required`，文件只写入一次。

恢复评测 v1 当前为 3/3 通过，报告见 `eval-results/2026-07-18-recovery-eval-v1.md`。

## 8. SQLite 数据结构

当前保持七张业务表：

| 表 | 职责 |
|---|---|
| `threads` | 会话 |
| `messages` | 对话消息及用户可见/内部消息标记 |
| `agent_runs` | 一次执行、生命周期、Trace 健康度和 Checkpoint |
| `trace_events` | 不可修改的执行事件历史 |
| `tool_calls` | 已完成工具调用的最终凭证 |
| `tasks` | REST API 异步任务队列 |
| `memories` | 长期记忆事实、来源、作用域、置信度和生命周期 |

设计原则：经常查询和关联的字段结构化存储，变化频繁的 Plan、Trace 数据和 Checkpoint 使用 JSON TEXT。
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

- 从用户消息和 Agent 回复中异步抽取事实，并记录来源 Thread 与 Run；
- `global` 记忆跨 Thread 召回，`thread` 记忆只在所属 Thread 召回；
- 中英文关键词及中文 bigram 检索；
- 记忆抽取默认不阻塞用户回复；
- 每条记忆包含置信度、`active` / `superseded` / `expired` 状态、可选过期时间和最近召回时间；
- 同作用域同名事实采用确定性冲突策略：同值增强，置信度不低的新值替代旧值，低置信度冲突仅保留为历史；
- CLI 可列出、查看和精确删除记忆，API 可创建、查询、更新和删除记忆。

记忆治理保持单表设计，没有引入向量数据库、自动反思或自动优化 Agent 的逻辑。模型抽取记忆默认使用
`global` 作用域和 `0.7` 置信度，以保持现有跨会话体验。当前仍缺少“哪些记忆被召回、为什么召回”的 Trace，
检索排序也仍是关键词匹配加置信度/更新时间，而非语义向量检索。

## 11. 已知限制

- `write_file` 中断后尚未自动核对目标文件内容，v1 会保守地要求人工处理；
- `append_file`、`delete_file`、`run_command` 等副作用工具不自动恢复；
- Checkpoint 目前只覆盖 PlanningLoop；
- CLI 支持显式 `/resume`，REST API 暂未提供恢复端点；
- SQLite 迁移仍使用兼容式列检查，后续可增加版本化 `schema_migrations`；
- `tasks.events`、`reasoning_chain` 与 Trace 存在部分信息重复，需要逐步明确唯一事实来源；
- 长期记忆仍是关键词检索模型，尚未把召回依据写入 Trace。

## 12. 下一阶段方向

1. 恢复 v2：为 `write_file` 增加目标内容或哈希核对，在确认结果后跳过或安全重试；
2. 扩展故障注入点，覆盖多步骤、重规划、连续恢复上限和进程启动阶段；
3. 记忆可观测性：把召回候选、命中依据和最终注入项记录进 Trace，并建立离线评测集；
4. 逐步消除重复状态来源，强化数据库迁移和状态约束；
5. 继续增强 Trace Viewer 的人工分析能力：工具调用配对、事件搜索、慢步骤定位与导出。

## 13. 文档与提交约定

以后每次修改遵循：

1. 实现并验证功能；
2. 更新本文档中受影响的定位、设计、现状或限制；
3. 使用清晰的 Git commit 标题和详细正文，正文说明动机、设计、行为变化、验证结果与限制；
4. 推送到 GitHub；
5. 不提交密钥、用户数据、运行数据库、WAL、日志或评测任务生成的临时文件。
