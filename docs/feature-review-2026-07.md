# one-agent 功能全景回顾与问题审视

**日期**：2026-07-16
**范围**：`packages/agent-core` 全部模块 + `apps/cli`、`apps/api`、`apps/trace-web`
**方法**：全代码走查（关键结论已对源码二次核实；SQLite 迁移与 shell 拦截规则经实际执行验证）

---

## 一、功能全景

### 1. 核心运行时（AgentLoop）

- **三种运行模式**：简单循环（工具调用直到出答案）、规划循环（plan → 逐步执行 → judge → retry/replan/finalize）、`--plan-auto` 自动分类（一次低开销调用判断走哪条路，分类失败安全降级为规划）。
- **流式输出**：completion 逐 token 推送 `message_delta`，推理内容分离为 `reasoning_delta`；支持 `include_usage` 提取真实 token 用量；流式工具调用增量拼装。
- **取消与超时**：每轮 `AbortController`，模型调用带超时重试。

### 2. 规划体系（Phase 4 + 11）

- **Planner**：jsonMode 单次调用生成计划，zod 校验，失败回退单步计划；支持递归 `children` 层级计划、`delegate`/`parallel` 委派标记、`toolName` 工具约束。
- **执行绑定**：`PlanStep.toolName/allowedTools/requiredTool/strict` 约束每步可用工具 schema；偏离计划时记录 `failureAnalysis` 并交给 Judge。
- **TaskJudge**：结构化失败分析（category / affectedStepIds / rootCause / recommendation），驱动 retry / replan / finalize。
- **ReasoningChain**：thought/action/observation/reflection 全记录，随 run 持久化，支持 planStepId 绑定。

### 3. 子 Agent（Phase 15 + 16）

- `spawn_agent` 工具 + `SubAgentRunner`：隔离上下文、独立 AgentLoop 实例、深度受限（depth=1 禁止再嵌套）。
- 规划器 `delegate+parallel` 步骤组成**波次并行**（`Promise.allSettled`），波次内强制只读工具集避免写冲突。
- 观测性：子 Agent 事件流折叠进父 trace 的 `sub_agent` 事件，trace-web 支持嵌套展示；子 Agent 走 `UTILITY_MODEL` 降级省成本。

### 4. 工具体系（Phase 2 + 13）

- 文件工具全家桶（read/write/append/delete/list/search）+ `run_command`（cwd 限定 workspace、30s 超时、输出截断、危险命令 blocklist）+ `web_search`（Tavily/Brave/通用 API/DuckDuckGo 降级链）+ `get_time`。
- Sandbox 路径归一化限定 workspace；`DISABLED_TOOLS` 环境变量按名禁用。
- 工具工厂目录自扫描注册，新增工具只需加文件。

### 5. 上下文与记忆（Phase 3 + 10）

- token 预算模式（`maxContextTokens`/`recentTokenBudget`）+ 启发式估算（CJK≈1 token/字，ASCII≈4 字符/token），超预算自动摘要压缩。
- 长期记忆：每轮对话后 utility 模型提取 `{key,value}` 事实入库，后续按关键词召回注入，跨 thread 共享。

### 6. 模型层（Phase 12）

- `ModelProvider` 统一接口；`OpenAICompatibleProvider` 覆盖所有 OpenAI 兼容端点；`FallbackProvider` 主备 failover（5xx/429/网络错误）。
- 分场景模型：`PLANNING_MODEL`（规划/判定）、`UTILITY_MODEL`（摘要/记忆/子 Agent），未设置回退主模型。

### 7. 持久化与任务队列（Phase 5 + 6 + 9）

- SQLite（WAL）：threads / messages（单调 sequence）/ agent_runs / trace_events / tool_calls / tasks / memories 七张表。
- `TaskQueue` + `QueueWorker`：后台异步执行、幂等键去重、指数退避重试、死信队列、超时中断、API 重启恢复。

### 8. 观测性与评估（Phase 7 + 14 + 16）

- 全事件 trace 持久化；trace-web 三栏查看器（threads | runs | traces），失败 run 红色标记 + 错误摘要。
- EvalRunner：mock 回放 / real 模型双模式，JSON 数据集（zod 校验、重复 id 检测），工具顺序/必需/禁用/答案包含/文件断言，token 与规划指标；eval trace 落库 + `[PASS]/[FAIL]` thread 标题，失败现场可在 trace-web 回放。

### 9. 应用层

- **CLI**：REPL + 斜杠命令（/history /context /reasoning /threads /runs /traces /thread），会话恢复、双 Ctrl-C 语义、TTFA 与 token 统计、`--trace` 联动拉起 trace-web、全局 `one-agent` 命令。
- **API**：Fastify REST + 任务 SSE 流式推送。

---

## 二、P0 — 正确性缺陷（建议尽快修）

> **2026-07-17 更新**：第 1、2、6、8 项已修复（第一批止血），修复细节见 `docs/correctness-fixes.md` 第八节。

### 1. ✅ replan 预算耗尽时，失败步骤被静默标记为 completed（已修复）

`AgentLoop.ts:500-532`：`executionResult.next === 'replan'` 且 `replanAttempts >= maxReplanAttempts` 时，第 500 行的守卫不通过，`retry` 分支（509/524）也不匹配，控制流落到 528-529 行 `unit.step.status = 'completed'` 并推进到下一步——**失败的步骤被当作成功**，最终以"成功"收尾。第 521-523 行的注释声称要防止的正是这件事，但只挡住了 `retry` 路径。
**修复**：fall-through 前补 `if (executionResult.next === 'replan') return this.finalizeAnswer();`。

### 2. ✅ 未配对的 tool_calls 污染对话历史，可致整轮运行死亡（已修复）

`AgentLoop.ts:742-747` 在校验/执行**之前**把带 `tool_calls` 的 assistant 消息写入 context：

- 偏离路径（754-775）直接 return，这些调用永远没有对应 `tool` 消息；
- 多调用时首个失败即 return（795-818），第 2..N 个调用没有响应。

严格端点（OpenAI 兼容）会拒绝后续所有请求（"assistant message with tool_calls must be followed by tool messages"），`callModel` 确定性重试后抛出，**一次工具偏离等于整轮 fatal**。
**修复**：偏离/失败返回前补齐占位 `tool` 消息，或回滚未执行的 tool_calls 消息。

### 3. 波次并行在共享 ReasoningChain 上竞态

`executeWave` 并发跑 `executeDelegatedStep`，但所有委派步骤共享父级唯一的 `ReasoningChain`：`setCurrentPlanStepId`（672）、`addThought`（685）、`commitStep`（690）。`addThought` 是**覆盖写**（`ReasoningChain.ts:18-21`），并发步骤互相覆盖：一个步骤的 thought 丢失、`planStepId` 归属不确定、`contextManager.addMessage` 顺序交错。
**修复**：ReasoningChain 改为显式 per-step builder，planStepId 作参数传入而非环境状态。

### 4. 子 Agent token 汇总污染父上下文记账

`runSubAgent` 调 `accumulateUsage`（1182-1184），后者把子 Agent 的 promptTokens 写入 `updateLastKnownTokens`（952-954）。`ContextManager` 把它当作**父级**最近一次真实 prompt 大小做增量估算——子 Agent 的 prompt 远小于父级，导致父级低估自身上下文、跳过摘要，直到 API 侧溢出报错。
**修复**：子 Agent 用量只累加进总数，不碰 `lastKnownPromptTokens`。

### 5. TaskQueue.enqueue 重复幂等键 → 重复执行 + 取消失效

`TaskQueue.ts:38-47` 无条件 `tasks.set(...)`（新 AbortController）+ `pending.push(id)`；而 store 对已有幂等键返回**已存在**任务。后果：

- 运行中任务的 AbortController 被覆盖，`cancel()` 中断的是新控制器，Agent 照跑；
- id 再次入队，`acquireNext` 把 even `completed` 任务翻回 `running`，**重复执行**。

### 6. ✅ 老库迁移失败：tasks.idempotency_key 加不上（已修复）

`connection.ts:148-151` 用 `ALTER TABLE tasks ADD COLUMN idempotency_key TEXT UNIQUE`——SQLite 禁止 ALTER 加 UNIQUE 列（已实际验证）。错误被裸 catch 吞掉，老库永远没有该列，随后 `SqliteTaskStore.create` 的 INSERT 引用该列直接抛 "no such column"。
**修复**：先加普通列，再 `CREATE UNIQUE INDEX ... WHERE idempotency_key IS NOT NULL`；引入 `PRAGMA user_version` 版本化迁移。

### 7. 崩溃恢复链路不通

- `TaskQueue.restore()` 把 crashed `running` 任务塞进 `this.running` 但无人执行/释放——默认 `maxConcurrency=1` 下**并发槽永久泄漏**，队列卡死；
- `restore()` 全仓库无调用方；API 启动时的 rehydration 走自己的逻辑，且会撞上第 5 条的 enqueue 问题；
- `stop()` 中断 pending 任务却不出队，重启后拿到已中止 signal 立即失败。

### 8. ✅ 摘要失败永久销毁上下文（已修复）

`ContextManager.summarize` 捕获所有错误返回 `"Summary unavailable: <err>"`（263-266），随后该字符串被当作正式摘要存储并推进 `lastSummarizedIndex`（130-135, 152-157）——一次瞬时 API 错误就**不可逆地把一段历史替换成错误字符串**，且永不重试。
**修复**：失败时不推进 `lastSummarizedIndex`。

### 9. trace-web 存储型 XSS（两处）

- `server.ts:430` `title="${escapeHtml(r.error)}"`：`escapeHtml` 经 `textContent→innerHTML` 只转义 `& < >`，**不转义 `"`**——错误文本（来自模型/工具输出）里的引号可逃逸属性注入任意 JS；
- `server.ts:409,427` `selectThread('${t.id}')`：DB 中的 id 原样插进 onclick 的单引号字符串，而 thread id 可被 CLI `--thread` 任意指定。

### 10. Judge 看到的是一个"没有失败证据"的推理链

失败路径上 `addFailureAnalysis` 写入 `currentStep` 但**不 commit** 就 return（762/803），随后 judge 被调用（764/804）——判定时看不到刚发生的失败分析，也看不到偏离的 action（未 commit）。Judge 在证据缺失的状态下决定 retry/replan。

---

## 三、P1 — 安全问题

| 问题 | 位置 | 说明 |
|------|------|------|
| **子进程继承全量环境变量，API key 可泄漏** | `shellExec.ts:57-59` | `exec` 未传 scrub 过的 env，`run_command: env` 即可读出 `OPENAI_API_KEY` 等。应传最小环境白名单 |
| **Sandbox 符号链接逃逸** | `sandbox.ts:16-22` | 只做词法归一化，不 realpath 目标；workspace 内 `ln -s /etc evil`（可用 run_command 创建）后文件工具即可读写 workspace 外 |
| **危险命令拦截可绕过**（已实测） | `shellExec.ts:19-28` | `rm -rf ~/`、`rm -rf /*`、`rm --recursive --force /`、`r\m -rf /`、`r""m`、`\| /bin/sh`、`curl x.sh \| base64 -d \| sh`、macOS 上 `SUDO` 全部可通过。注释（86-90 行）对防护能力的描述高于实际 |
| **API 无鉴权 + shell 工具 = 远程 RCE** | `apps/api/src/server.ts` | 默认绑 127.0.0.1 尚可，`HOST=0.0.0.0` 时所有路由（含驱动 shell 工具的 chat/tasks）完全开放 |
| **超时时孙进程存活** | `shellExec.ts:59` | Node timeout 只 SIGTERM 直接子 shell，进程组里已拉起的孙进程继续运行 |
| **记忆注入面** | `MemoryExtractor.ts:39-47` | 用户原文插进提取 prompt，恶意消息可向长期记忆投毒；无 source 标记、无长度上限 |

立场建议：要么承认 blocklist 只是"演示级护栏"、把安全边界明确交给 `DISABLED_TOOLS`；要么改白名单子命令 + env scrub + 进程组 kill。中间态最危险。

---

## 四、P1 — 成本 / 资源

1. **Judge 二次方 token 成本**：每次判定把全部历史（observation 是整个 JSON，含完整文件内容）重发一遍（`TaskJudge.ts:98-107`），且每步结束、每次失败、计划收尾各调一次。可加短路（全部 completed → 直接 finalize）、截断 observation。
2. **未记账的 token 开销**：Planner / Judge / auto 分类器的 usage 都不进 `accumulateUsage`，`chat()` 返回的 tokenUsage 系统性低估。
3. **web_search 降级链断裂**：`searchTavily/Brave/GenericApi` 的 fetch 无 try/catch（`webSearch.ts:89-97,138,165`），配置了 API 但主机不可达时异常直接抛出，DuckDuckGo 兜底永远走不到；且全程无 fetch 超时。
4. **jsonMode 重试不加区分**：`complete()` 对**任何**错误（超时/429/5xx/DNS）都去掉 `response_format` 重试一次（`OpenAICompatibleProvider.ts:32-41`），故障期间负载翻倍。应只对疑似 `response_format` 不支持的 400 重试。
5. **每 token 一条 trace row**：`message_delta` 逐 chunk 落库（`AgentLoop.ts:1204-1217`），长会话产生数万行；trace 端点无分页，浏览器端再聚合。应聚合持久化或加分页。
6. **波次重试重跑已成功步骤**（`AgentLoop.ts:513-515` 只重置 failed，但 619-620 每次 map 全部步骤）；**层级计划父步骤冗余执行**（children 做完后父步骤又当普通步骤跑一遍，536-550 + 485-488）。
7. **fallback 错误掩码**：failover 后抛出的是**备用** provider 的错误（`FallbackProvider.ts:51`），主因被 401 之类掩盖；abort 被误判为可 failover（SDK 抛的是 `APIUserAbortError` 而非 `AbortError`，`FallbackProvider.ts:12` 匹配不到 → fall through 到 `return true`）。
8. **估算偏差**：token 启发式对代码/JSON（~2 字符/token）低估约 2 倍，恰好压在 agent 工具调用主力场景上（`tokenEstimate.ts:38`）；摘要和 memory 块不计入预算，长对话实际 prompt 可无界超预算。

---

## 五、P2 — 设计 / 可维护性

1. **AgentLoop 约 1300 行职责过载**：循环编排 + 规划编排 + 流式策略 + trace + 持久化 + 记忆 + 委派。`callModelStreaming` 与 `streamModel` 近乎重复；judge→next-action 映射重复四份且有细微漂移。建议抽流式调用器、trace sink、规划执行器。
2. **两条委派路径安全语义不一致**：planner 波次强制只读 + 有记忆注入；`spawn_agent` 工具拿全量工具（含写）+ 无记忆。只读不变量只靠 prompt 约定 + 硬编码工具名列表维持。
3. **ReasoningChain 环境态 currentStep 设计**：覆盖写、commit 语义不对称（addObservation 提交，addFailureAnalysis 不提交），是 P0-3/10 的根因。另 `toMessages`/`getStepsByPlanByStep` 全仓库无调用。
4. **eval 评分面有死字段**：`expectedOutcome` 声明了但从不检查；`assertPlanEventContains` 实现完整但无调用方；`planningMetrics.retryCount` 恒为 0——指标给人一种并未真实测量的覆盖感。参数相等用 `JSON.stringify` 比较，键序敏感，real 模式有 flaky 风险。mock 走全局 monkey-patch `config.openai`，无法并行。
5. **死代码 / 误导性 API**：`TaskJudge.canRetry/canReplan/recordRetry/recordReplan` 无人调用（限制实际由 AgentLoop 自己的计数器控制）；`AgentLoop.ts:458-483` anyChildFailed 分支不可达；`maxSubAgentDepth` 选项名不副实（SubAgentRunner 硬编码 depth=1，不转发）；`parallel` 注释说 "Implies delegate" 但无任何强制。
6. **上下文管理**：`PersistenceContextManager` 全量历史回放进内存且摘要状态不持久化（每次 resume 重付一次全量摘要）；message+timestamp 两次写入无事务；`tool_calls.created_at` 秒级精度无次序 tiebreaker。
7. **记忆召回对中文近乎失效**：`extractKeywords` 按空白分词，无空格中文整段成一个 keyword，LIKE 几乎永不命中（`memoryStore.ts:38-45`）——与默认中文 persona 直接冲突。可考虑 2-gram 分词或 FTS5。
8. **配置健壮性**：`Number(env)` 不校验 NaN（`maxContextTokens=NaN` 时每轮都触发摘要）；import 时即构建 client，测试和嵌入方不友好；`OPENAI_API_KEY` 允许为空。

---

## 六、小问题清单（顺手修）

- CLI 版本号硬编码 `0.0.1`，与 package.json `0.1.0` 不一致（`help.ts:43`）
- Ctrl-C 退出时 trace-web 子进程不被 kill，残留占用 3001 端口（`index.ts:291-300` vs 314）
- `new URL(...).pathname` 未用 `fileURLToPath`，含空格/中文路径时 `--trace` 静默失败（`index.ts:236`）
- eval CLI 临时目录不清理（`eval.ts:23`）
- trace-web run 列表 active 高亮永不生效（`server.ts:441` 匹配不到的文本）
- API SSE 注册监听器与状态检查之间存在竞态，错过终态事件客户端永远挂起（`tasks.ts:132-197`）；无心跳
- `sandbox.ts:18` `includes('..')` 误伤 `foo..bar.txt` 等合法文件名；扩展名白名单挡掉 `Makefile`/`.gitignore`/`.log`/`.csv` 等文本文件
- `search_files` 通配正则不锚定（`*.md` 匹配 `foo.md.bak`）、单文件读取异常让整次搜索失败、无扫描上限
- `read_file` 无大小上限，大文件直接打爆上下文
- `extractJson` 贪婪正则取到第一个 `{` 到最后一个 `}`，模型输出含第二个 JSON 对象时解析失败静默回退
- `chat()` 实例状态不复位隔离，不可重入；`emitEvent` 里监听器异常会打穿整个 run
- 记忆上下文跨 chat 残留（无相关记忆时不清空上一次的 memory block）
- 流式 `message_delta` 对工具轮也推送，拼接显示的客户端会把中间过程混进"答案"；reasoning 回退路径会重复显示一遍

---

## 七、建议修复顺序

| 批次 | 内容 | 理由 |
|------|------|------|
| 第一批（正确性止血） | P0-1 replan 落洞、P0-2 tool_calls 配对、P0-8 摘要失败、P0-6 迁移修复 | 都是"静默做错事"，直接影响结果可信度；改动小、收益大 |
| 第二批（安全基线） | shellExec env scrub、symlink realpath、trace-web 转义、API 鉴权说明/默认收紧 | 明确护栏的真实边界，堵住密钥泄漏 |
| 第三批（并发与队列） | P0-3 ReasoningChain 重构、P0-5/7 队列幂等与恢复、P0-4 token 记账 | 子 Agent 波次是 Phase 15/16 的核心，竞态不修则 trace 与判定都不可靠 |
| 第四批（成本） | Judge 短路+截断、usage 全记账、web_search 兜底修复、trace 聚合 | 纯优化，不影响语义 |
| 第五批（结构） | AgentLoop 拆分、eval 死字段补齐、记忆中文召回 | 为下一阶段（MCP？多 Agent 协作？）打底 |

---

## 八、总体评价

架构主线是清晰且健康的：模型抽象、工具沙箱、规划-判定-重规划闭环、trace 与 eval 联动，16 个阶段的演进层次清楚，测试覆盖面在同类项目里算好的。**当前的主要矛盾已经从"缺功能"转为"正确性细节"**：规划循环的失败路径、并发波次的共享状态、队列的幂等与恢复，这三处的缺陷都是"静默地给出看似正常但其实错误的结果"——比崩溃更危险。建议下一阶段暂缓新功能，按上面的批次做一轮正确性巩固。
