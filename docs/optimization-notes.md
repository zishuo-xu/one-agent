# 现有阶段优化点记录

> 文档状态：历史分析快照（非当前阶段总览或待办清单）
> 阅读说明：本文的“当前阶段”和优化建议截止 2026-07-13，后续多项已经实现或改变。当前事实与候选方向见 [项目现状](./project-vision-and-status.md)，历史分类见 [文档索引](./README.md)。

**日期**：2026-07-13  
**项目**：one-agent  

---

## 一、当前阶段总览

| 阶段 | 状态 | 核心模块 |
|------|------|----------|
| Phase 1：单 Agent | ✅ | `AgentLoop`、`config` |
| Phase 2：Tool Calling | ✅ | `ToolRegistry`、`ToolExecutor`、`Sandbox`、文件工具 |
| Phase 3：上下文与记忆管理 | ✅ | `ContextManager`（滑动窗口 + 摘要） |
| Phase 4：规划与自我纠错 | ✅ | `Planner`、`ReasoningChain`、`TaskJudge` |
| Phase 5：SQLite 持久化 | ✅ | `ThreadStore`、`MessageStore`、`RunStore`、`ToolCallStore`、`PersistenceContextManager` |
| Phase 6：异步任务与流式输出 | ✅ | `TaskQueue`、`QueueWorker`、`TaskStatusStore`、SSE |
| Phase 7：Trace 与 Evaluation | ✅ | `TraceEventStore`、`EvalRunner`、内置 scenarios |
| Phase 8：全局 CLI 命令 | ✅ | `workspace.ts`、全局 `one-agent` 命令 |
| Phase 9：任务持久化 | ✅ | `SqliteTaskStore`、`TaskQueue` restore、API 重启恢复 |
| Phase 10：长期记忆检索 | ✅ | `MemoryStore`、`MemoryExtractor`、跨 thread 召回 |
| Phase 11：规划能力深度增强 | ✅ | 计划绑定、层级计划、结构化反思、真实模型评估 |
| Phase 12：多模型抽象层 | ✅ | `ModelProvider` 接口、`OpenAICompatibleProvider`、`FallbackProvider` 主备切换 |
| Phase 13：工具生态扩展 | ✅ | `run_command` Shell 工具、`append_file`/`delete_file`/`search_files`、`DISABLED_TOOLS` |
| Phase 14：Eval+Trace 联动 | ✅ | eval trace 持久化、[FAIL]/[PASS] 标记、JSON 数据集独立管理、trace-web 失败现场 |
| Phase 15：子 Agent | ✅ | SubAgentRunner、spawn_agent 工具、delegate/parallel 波次并行、只读约束、递归阻断 |

---

## 二、Phase 1 优化点

**当前状态**：已跑通，CLI 和 API 都能调用模型返回回答。

1. **配置热加载**  
   目前 `.env` 只在启动时加载一次，运行中修改不生效。可支持 `SIGHUP` 重载或 CLI 命令 `/reload`。

2. **系统 prompt 可配置化**  
   当前系统 prompt 写死在 `.env`，可支持 CLI 中 `/system <prompt>` 临时切换。

3. **流式输出** ✅  
   已实现。单次流式 completion 逐 token 推送 `message_delta` 事件，CLI 实时显示回答；同时分离 `reasoning_content` 通过 `reasoning_delta` 事件流式推送推理链。

4. **多模型抽象层** ✅  
   已实现。`ModelProvider` 接口统一模型调用，`OpenAICompatibleProvider` 覆盖所有 OpenAI 兼容端点，`FallbackProvider` 支持主备自动切换（env 配置）。详见 `docs/phase12-multi-model.md`。

---

## 三、Phase 2 优化点

**当前状态**：已实现 `read_file`、`write_file`、`list_files`、`get_time`，有沙箱和参数校验。

1. **工具错误重试粒度**  
   目前 `TaskJudge` 控制重试，但 `ToolExecutor` 本身也可增加重试策略（如网络类工具）。

2. **工具注册自动扫描** ✅  
   已实现。`built-in/index.ts` 通过 `loadBuiltInFactories()` 动态扫描目录，自动加载所有 `default export` 的工具工厂，新增工具只需添加文件即可。

3. **文件工具增强** ✅  
   - ✅ `web_search`：网络搜索。优先走 `SEARCH_API_URL` 配置（Tavily/Brave，推荐），未配置时回退 DuckDuckGo HTML 抓取（免 key、低频可用、突发会限流）；Instant Answer 兜底已移除（对 Node TLS 指纹返回空 body，从未生效）
   - ✅ `append_file`：追加内容
   - ✅ `delete_file`：删除文件（workspace 限定，拒目录/路径穿越）
   - ✅ `search_files`：按文件名通配 + 内容子串搜索 workspace（跳过 node_modules/.git/dist）

4. **Shell 执行工具** ✅  
   已实现 `run_command`：cwd 限定 workspace、默认 30s 超时（上限 120s）、输出截断（每流 10000 字符）、危险命令 blocklist（sudo / rm -rf / / 磁盘操作 / 管道远程脚本等）；非零退出码作为正常结果返回供模型自纠。信任模型与护栏局限详见 `docs/phase13-tool-ecosystem.md`。API 部署可用 `DISABLED_TOOLS` 禁用。

5. **工具返回值规范化**  
   当前工具返回任意对象，`ToolExecutor` 包装为 `{ success, data }`。可统一所有工具返回标准结构。

---

## 四、Phase 3 优化点

**当前状态**：按 token 估算压缩（向后兼容消息数量模式），保留 system + 摘要 + token 预算内的最近消息。

1. **按 token 压缩** ✅  
   已实现。`ContextManager` 新增 `maxContextTokens`（默认 4096）和 `recentTokenBudget`（默认 2048）配置；通过 `tokenEstimate.ts` 的轻量启发式估算 token 数（CJK ~1 token/字，ASCII ~4 字符/token，无需外部依赖）；当总 token 超预算时触发摘要，保留预算内的最近消息。向后兼容：未设置 `maxContextTokens` 时回退到消息数量逻辑。`/context` 命令显示 token 估算和预算。

2. **分层摘要**  
   目前摘要会不断追加。可引入分层摘要（旧摘要再摘要）避免无限增长。

3. **长期记忆检索** ✅  
   已实现。每轮对话后自动提取关键事实写入 `memories` 表，后续问题按关键词召回并注入上下文，支持跨 thread 共享。详见 `docs/phase10-memory.md`。

4. **上下文可观测性** ✅  
   `/context` 已展示 token 估算、预算、摘要状态和最近消息预览。

---

## 五、Phase 4 优化点

**当前状态**：Planner 生成计划，AgentLoop 执行并记录 ReAct 推理链，TaskJudge 判定完成/重试/重规划。

1. **Planner JSON 输出稳定性** ✅  
   已优化。`Planner` 与 `TaskJudge` 在解析 JSON 前先剥离 markdown 代码块、提取首个 JSON 对象；同时启用 `response_format: { type: 'json_object' }` 并在 prompt 中加入 one-shot 示例，降低回退为单步计划的概率。

2. **计划与执行绑定** ✅  
   已支持。`PlanStep` 新增 `toolName` / `allowedTools` / `requiredTool` / `strict` 等约束；`AgentLoop.executeStep` 根据约束限制可调用工具 schema，并在工具偏离计划时记录 `failureAnalysis` 并触发重试/重规划。

3. **子目标拆解** ✅  
   已支持。`Planner` 的 JSON schema 支持递归 `children`；`AgentLoop` 按后序遍历深度优先执行子步骤，父步骤状态由子步骤聚合。

4. **反思质量提升** ✅  
   已支持。`TaskJudge` 输出结构化 `failureAnalysis`（category、affectedStepIds、rootCause、recommendation），`AgentLoop.replan` 将其作为上下文生成更精准的新计划。

5. **规划开关粒度** ✅  
   已实现。`enablePlanning` 支持 `'auto'`：每轮对话由一次低开销分类调用判断走规划循环还是直接回答，判定结果作为 thought 事件进入 trace；分类器失败时安全降级为规划。CLI 对应 `--plan-auto` 参数。

6. **按场景选模型** ✅  
   已实现。`PLANNING_MODEL`（规划/判定）与 `UTILITY_MODEL`（摘要/记忆提取）环境变量可为不同场景指定模型；未设置时统一回退到主 provider。

7. **推理链持久化** ✅  
   当前 reasoning chain 已随 run 持久化到 `agent_runs.reasoning_chain`。`ReasoningChain` 支持 `planStepId` 绑定，方便后续按 plan step 查询。

8. **Judge 成本优化** ✅（2026-07-17，correctness-fixes 第九节）  
   已实现。满足 `toolName` 约束且成功的步骤跳过 Judge（机械校验替代 LLM）；计划全部完成时收尾不再做全量历史判定；Judge prompt 各字段截断 800 字符消除二次方成本。planner/judge/分类器 usage 全部计入 `tokenUsage`（此前不记账，成本被低估）。层级计划父步骤容器化：children 完成后自动 completed，不再重复执行。

---

## 六、Phase 5 优化点

**当前状态**：`threads`、`messages`、`agent_runs`、`tool_calls` 已持久化到 SQLite，CLI 和 API 均支持 thread 切换与历史查询。

1. **长期记忆检索** ✅  
   已实现。每轮对话后自动提取关键事实写入 `memories` 表，后续问题按关键词召回并注入上下文，支持跨 thread 共享。详见 `docs/phase10-memory.md`。

2. **Thread 标题自动生成**  
   当前标题取首条用户消息前 50 字符。可让模型基于首条消息生成更简洁的标题。

3. **会话归档与清理**  
   长期运行后 threads 表会增长。可支持按时间归档、删除旧 thread 的命令。

4. **DB 连接池/生命周期**  
   当前 `getSharedConnection()` 全局单连接。后续若 API 多 worker，可考虑连接管理策略。

5. **迁移文件管理**  
   当前 SQL 内联在 `connection.ts`。后续阶段变多后，可引入版本化迁移机制。

---

## 七、Phase 6 优化点

**当前状态**：AgentLoop 实时推送事件，TaskQueue + QueueWorker 支持后台异步执行，API 提供 SSE 流式任务，CLI 实时展示过程。

1. **任务持久化** ✅  
   已实现。`TaskQueue` 支持注入 `TaskStore`，API 使用 `SqliteTaskStore` 并将重启前未完成的 `pending` / `running` 任务恢复后重新派发。详见 `docs/phase9-task-persistence.md`。

2. **任务超时** ✅  
   已实现。`TaskQueue` 支持 `taskTimeoutMs`，`QueueWorker` 用 `Promise.race` 在超时时触发 `AbortController`，任务标记为 `failed` 并记录 `Task timeout`。

3. **重试与死信队列** ✅  
   已实现。任务失败时 `QueueWorker` 自动按指数退避重试，超过 `maxRetries` 后进入 `dead_letter` 状态；API 提供 `POST /api/tasks/:id/retry` 手动重试。详见 `docs/phase9-task-persistence.md`。

4. **并发与限流**  
   当前 `maxConcurrency` 是固定值。可支持按任务类型或用户限流，避免某个用户占用全部 worker。

5. **SSE 断线重连**  
   客户端断开后丢失后续事件。可支持 `Last-Event-ID` 或基于事件索引的断点续传，从上次位置继续推送。

6. **OpenAI 流式覆盖率**  
   当前仅最终回答使用 `stream: true`。thought 和 tool 阶段仍是非流式，后续可全面流式化。

7. **CLI 异步任务模式**  
   当前 CLI 仍同步等待回答。可支持 `/task` 命令创建后台任务，再订阅事件流。

---

## 八、Phase 7 优化点

**当前状态**：`trace_events` 表已记录每次运行的事件流，`EvalRunner` 可用确定性场景跑回归测试。

1. **Trace 查询与可视化** ✅  
   已实现。新增 `GET /api/runs/:id/traces`、`GET /api/tasks/:id/traces`、`GET /api/threads/:id/traces` 路由，CLI 支持 `/traces` 与 `/traces <runId>` 命令查看事件流。另新增独立应用 `apps/trace-web`，可通过浏览器可视化展示 trace 时间线。详见 `docs/phase7-trace-evaluation.md`。

2. **Trace 采样与清理**（部分完成）  
   ✅ 2026-07-17：delta 事件聚合写入（每流一行替代每 token 一行，消除写放大）。剩余：按时间/任务/运行采样，或自动清理旧 trace。

3. **Evaluation 数据集扩展** ✅  
   已扩展到 20 个内置场景，覆盖 get_time、工具链(read→write)、规划失败重规划、禁止工具的纯知识回答等边界。数据集已迁移为独立 JSON 文件（`packages/agent-core/eval-datasets/`），支持 `--dataset <dir>` 加载外部数据集，zod 校验。

4. **Evaluation 指标细化** ✅  
   已增加 token 消耗（prompt/completion/total）、运行步数、重试次数、耗时、规划指标（planCount/replanCount/planStepCount/reflectionCount）。CLI eval 输出含每任务 token 统计和汇总行。

5. **真实模型评估** ✅  
   已支持。`EvalRunnerOptions` 新增 `mode?: 'mock' | 'real'`；mock 模式通过 `EvalTask.mockResponses` 回放预设响应，无需真实 API key；real 模式直接调用真实模型；`EvalResult` 增加 `tokenUsage`、`planningMetrics` 与 `reflectionCount` 等指标；CLI `eval` 命令支持 `--real` 参数运行多个 real-model 场景并输出 benchmark 报告（通过率、总 token、总耗时）。AgentLoop 通过 `stream_options: { include_usage: true }` 从流式响应中提取 token 使用量。

6. **Trace 与 Evaluation 联动** ✅  
   已实现。`EvalRunner` 支持 `traceDbPath`：每个任务在独立 thread 运行并持久化完整 trace，断言失败的任务标记 run 为 failed（含断言错误）、thread 标题前缀 `[FAIL]`/`[PASS]`；trace-web runs 列表红色标记失败 run 并显示错误摘要。详见 `docs/phase14-eval-trace.md`。

---

## 九、Phase 8 优化点

**当前状态**：CLI 已可全局安装，`one-agent` 命令会从 `~/.one-agent` 或指定目录启动。

1. **发布到 npm**  
   当前仅支持 `pnpm link --global` 本地测试。可发布 `@one-agent/agent-core` 和 `@one-agent/cli` 到 npm，让用户 `npm install -g @one-agent/cli`。

2. **安装脚本**  
   提供一键安装脚本（curl | bash），自动创建 `~/.one-agent/.env` 模板并安装 CLI。

3. **版本自检查**  
   CLI 启动时检查是否有新版本，提示用户升级。

4. **配置初始化向导**  
   首次运行时交互式引导用户填写 API key、选择模型等。

5. **数据迁移**  
   用户升级 CLI 时，旧版本 SQLite 数据自动迁移。

---

## 十、优化优先级建议

| 优先级 | 优化项 | 原因 |
|--------|--------|------|
| 🟠 高 | 任务持久化（✅ 已实现） | 当前进程重启丢失所有任务，生产环境必备 |
| 🟠 高 | Trace 查询与可视化（✅ 已实现） | 当前只有原始存储接口，需要暴露查询能力 |
| 🟠 高 | Evaluation 数据集扩展（✅ 已实现） | 目前只有 10 个场景，已扩展覆盖拒绝、空目录、文件恢复、长文本摘要、多工具规划等边界 |
| 🟠 高 | 计划与执行绑定（✅ 已实现） | 防止模型在 planning 模式下偏离既定步骤，提升可预测性 |
| 🟠 高 | 结构化反思与失败分析（✅ 已实现） | 让 Judge 显式输出根因与建议，支撑精准重规划 |
| 🟠 高 | 真实模型评估（✅ 已实现） | mock 回归之外需对真实模型跑 benchmark 并收集指标 |
| 🟡 中 | 任务去重与幂等（✅ 已实现） | 防止客户端重复提交导致重复执行 |
| 🟡 中 | 任务超时（✅ 已实现） | 当前依赖外部取消，应有默认超时保护 |
| 🟡 中 | 重试与死信队列（✅ 已实现） | 模型限流、网络抖动应可自动恢复 |
| 🟡 中 | 长期记忆检索（✅ 已实现） | Phase 7 Evaluation 需要超越对话历史的知识 |
| 🟡 中 | 文件工具 / 网络搜索扩展（✅ 已实现） | 通过 `web_search` 获取 workspace 外的实时信息 |
| 🟡 中 | Planner JSON 输出稳定性（✅ 已实现） | 影响 planning 体验，但已有 fallback |
| 🟡 中 | 层级计划（✅ 已实现） | 复杂任务需要子目标拆解 |
| 🟢 低 | SSE 断线重连 | 提升体验，但非核心能力 |
| 🟢 低 | 工具自动扫描注册（✅ 已实现） | 减少新增工具时的样板代码 |
| 🟢 低 | 系统 prompt 热切换 | 提升 CLI 交互体验，非核心能力 |
| 🟢 低 | 按 token 压缩上下文（✅ 已实现） | 更精确，但当前按消息数量已够用 |

---

## 十一、相关文档

- `docs/phase1-summary.md`
- `docs/phase2-summary.md`
- `docs/phase3-summary.md`
- `docs/phase4-summary.md`
- `docs/phase5-persistence.md`
- `docs/phase6-async-streaming.md`
- `docs/phase7-trace-evaluation.md`
- `docs/phase8-global-cli.md`
- `docs/phase9-task-persistence.md`
- `docs/phase10-memory.md`
- `docs/phase1-architecture.md`
- `docs/phase11-planning-enhancements.md`
- `docs/phase12-multi-model.md`
- `docs/phase13-tool-ecosystem.md`
- `docs/phase14-eval-trace.md`
- `docs/phase15-sub-agents.md`
- `docs/phase16-sub-agent-observability.md`
- `docs/cli-interaction-improvements.md`
- `docs/cli-ux-optimization.md`
- `docs/correctness-fixes.md`
- `docs/fixes-functional-test-2026-07.md`
- `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`

---

## 十二、待决策事项

1. 是否引入 tokenizer 来精确控制上下文？
2. ✅ 已决定：文件工具已扩展 `append_file` / `delete_file` / `search_files` / `run_command`（Phase 13）；删除确认机制、工具返回值规范化留作后续。
3. ✅ 已决定：任务状态持久化到 SQLite（`tasks` 表），暂不使用 Redis；若未来量极大再评估。
4. ✅ 已决定：Evaluation 数据集已独立为 JSON 文件管理（`eval-datasets/`，Phase 14），eval trace 持久化支持失败现场回放；失败案例集归档与人工复核留作后续。
