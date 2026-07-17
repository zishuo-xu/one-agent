# 核心正确性修复

**日期**：2026-07-14
**范围**：`packages/agent-core`、`apps/cli`
**目标**：修复 review 指出的五处核心正确性问题。

---

## 一、默认聊天路径其实不是真流式

**问题**：默认（非 planning）路径下 `runSimpleLoop` 用非流式 `callModel()` 拿到完整响应后才 `streamFinalAnswer()` 一次性 emit 全文。CLI 虽逐 delta 打印，但 delta 本身只有一条整段文本，用户体感仍是"等几秒后一次性显示"--这正是"你好为什么慢"的根因。第一版修复采用"探测+流式"两步，但大多数正常响应仍会复现"首字几秒后一次性显示"。

**最终修复**：改为单条流式补全同时承担两件事：
- 新增 `callModelStreaming()`：发起 `stream:true` 请求，边读边把 `delta.content`（含 `reasoning_content` 回退）作为 `message_delta` 事件实时抛给客户端；同时按 `index` 累积 `delta.tool_calls` 的函数名与参数分片（OpenAI 工具调用是分片到达的）。
- `runSimpleLoop` 每轮只调用一次 `callModelStreaming()`：若流结束后有完整 tool_calls，执行工具并循环；若没有，文本已经实时输出过，只需 emit `message` 并返回。不再有"探测"二次请求，正常回答天然逐 token 流式。
- 兼容性：若兼容端点忽略 `stream:true` 返回整对象，回退到从 `message` 一次性读取 content + tool_calls，仍 emit 一条 `message_delta` 保持调用方契约。

**相关文件**：
- `packages/agent-core/src/agents/AgentLoop.ts`（`runSimpleLoop`、`callModelStreaming`，删除 `streamFinalAnswerOrProbe`）
- `packages/agent-core/tests/correctness-fixes.test.ts`

**验证**：
- 正常（带内容）回答：单次请求、`stream:true`、产出 `['Hel','lo']` 两条独立 delta，证明逐 token 流式而非一次性。
- 工具调用：流中交错出现 content 分片和被拆成两段的 tool_call 参数分片，能正确累积成 `echo({"message":"hi"})` 并执行，第二轮流式输出最终回答。
- 非流式回退：端点返回整对象时仍 emit 一条 `message_delta`，`reasoning_content` 回退也生效。

---

## 二、恢复会话重复注入 system prompt

**问题**：`PersistenceContextManager.loadThread()` 先调用 `super.clear()`（`ContextManager.clear()` 已恢复一条 system 消息），紧接着又 `super.addMessage({role:'system', ...})` 再加一条。结果每个带 `threadId` 的 Agent 都可能向模型传入两份相同的 system prompt。

**修复**：删除 `loadThread()` 中的第二条 `super.addMessage({role:'system'})`，让 `clear()` 维持唯一 system 消息。

**相关文件**：
- `packages/agent-core/src/context/PersistenceContextManager.ts`

**验证**：恢复历史后 `getHistory()` 中 system 消息恰好一条，且位于索引 0。

---

## 三、恢复历史的消息顺序不可靠

**问题**：SQLite `datetime('now')` 精度为秒；一次工具调用中的 assistant tool-call、tool result、最终回复容易同秒写入。读取只按 `created_at ASC` 排序，时间相同时顺序未定义，可能把 tool result 排到 tool call 之前，破坏模型上下文。

**修复**：
- `messages` 表新增 `sequence INTEGER NOT NULL DEFAULT 0` 列，迁移用 `ALTER TABLE ... ADD COLUMN` 兼容旧库。
- 新增 `idx_messages_thread_sequence(thread_id, sequence)` 索引。
- `MessageStore.save()` 取 `MAX(sequence)+1` 作为该 thread 的递增序号写入。
- `getByThread()` 改为 `ORDER BY sequence ASC, created_at ASC, id ASC`，保证严格保存顺序。

**相关文件**：
- `packages/agent-core/src/db/connection.ts`（schema + 迁移）
- `packages/agent-core/src/db/messageStore.ts`（`save` / `getByThread`）

**验证**：同秒连续写入 4 条消息（user / assistant+tool_calls / tool / assistant）后 `getByThread` 顺序与写入一致。

---

## 四、规划模式把失败步骤标成完成

**问题**：`executeStep()` 工具执行失败时先 `step.status='failed'`，但若 Judge 返回 `continue`（未要求 retry/replan/finalize），函数最终仍返回 `continue`；外层循环无条件 `step.status='completed'; currentStepIndex++`，把失败覆盖成完成，最终回答可能声称任务已完成。

**修复**：
- `executeStep` 工具失败分支：无论 Judge 返回什么，只要不是 finalize/replan/retry，都显式返回 `{ next: 'retry', failureAnalysis }`，绝不落入 `continue`。
- `runPlanningLoop` 外层：当 `executionResult.next === 'retry'` 且重试预算已耗尽时，进入 `finalizeAnswer()` 而不是把 step 标成 completed。这样失败步骤始终保持 `failed`，最终回答不会谎称成功。
- 同时为该分支生成结构化 `FailureAnalysis`（`tool_failure` 类别、rootCause、recommendation），便于后续重规划。

**相关文件**：
- `packages/agent-core/src/agents/AgentLoop.ts`（`executeStep`、`runPlanningLoop`）

**验证**：Judge 一直返回 `continue`、工具一直抛错时，重试耗尽后 step 状态保持 `failed`，且 `tool_result` 事件 `success=false`。

> 说明：在该代码库中，工具的"失败"由 `ToolExecutor` 判定——工具 `execute()` 抛异常时 executor 返回 `{success:false, error}`；若工具仅返回 `{success:false, ...}` 对象，executor 会把它包成 `{success:true, data:{...}}`（视为"工具成功运行，只是返回了失败数据"）。因此修复覆盖的是 executor 层面的失败信号。

---

## 五、CLI 异常路径残留 spinner 和监听器

**问题**：`agent.chat()` 抛错时，`agent.off('event', onEvent)` 与 `progress.stop()` 被跳过。下一次请求可能因为残留 `onEvent` 重复输出，spinner 也可能持续刷新。

**修复**：把 `agent.off('event', onEvent)` 与 `progress.stop()` 移入 `try { chat } catch { throw } finally { off + stop }`，确保任何路径都释放本轮监听器并停止进度条。错误路径末尾补一个 `printSeparator()` 让分隔线闭合。

**相关文件**：
- `apps/cli/src/index.ts`

> 该路径属交互循环内部、依赖进程级 readline/stdout，按"手动 CLI 测试"约束未加自动化单测；行为通过 `chat-events` 的 `progress.stop` 契约测试间接覆盖。

---

## 六、清理遗留 DBG 输出

**问题**：`runPlanningLoop` 中残留 `console.log('DBG executeStep returned next=...')`，会污染 CLI、API 日志和 trace 阅读。

**修复**：直接删除该调试输出（已确认无其它依赖）。若未来需要诊断，应走可注入 logger 并仅在 verbose/debug 模式启用，而非裸 `console.log`。

**相关文件**：`packages/agent-core/src/agents/AgentLoop.ts`

---

## 六、验证结果

- `pnpm build` 通过。
- `pnpm test` 全绿：
  - `agent-core`：32 文件 / 167 测试（含 `tests/correctness-fixes.test.ts` 7 个）
  - `api`：4 文件 / 27 测试
  - `cli`：8 文件 / 57 测试
  - `trace-web`：1 文件 / 7 测试
---

## 七、复杂任务真实验证暴露的三处问题（2026-07-17）

**背景**：用「3 路并行只读委派 + 串行写 REPORT.md + 主 agent 汇总」的复杂输入做端到端验证时暴露的问题。四轮真实运行（deepseek-v4-flash）交叉确认。

### 1. 非 TTY 模式 spinner 污染输出

**问题**：管道/重定向下 spinner 的 `\r` 重绘帧覆盖进度行，日志中 `[sub-agent] started/done` 计数出现 4:5 假象（DB 记录是正确的）。

**修复**：`createProgressIndicator` 增加 `process.stdout.isTTY` 守卫，非 TTY 时 start 直接 no-op（进度行本身走 console.log，不受影响）。

**相关文件**：`apps/cli/src/index.ts`

### 2. 模型滥用绝对路径

**问题**：模型爱写 `/workspace/final-report.md` 这类路径。Sandbox 剥离前导斜杠安全收纳（无逃逸），但产物落进 `workspace/` 子目录，位置出人意料。

**修复**：五个文件工具的 path 参数描述补示例 + 明确禁止：`(e.g. "REPORT.md" or "src/index.ts"); never an absolute path.`。修复后再未出现嵌套目录。

**相关文件**：`packages/agent-core/src/tools/built-in/{readFile,writeFile,appendFile,deleteFile,listFiles}.ts`

### 3. Planner/Judge 产物忠实度（含一次措辞反噬）

**问题**：用户指定 `REPORT.md`，Planner 自造 `final-report.md`，靠两轮 replan 才纠正。

**修复与反噬**：第一版约束「request explicitly names artifacts ... MUST use those exact names」导致模型把「A、B、C 三份结果」字面化为**文件 A/B/C** 并反复搜寻（两轮运行均复现）——忠实度规则误伤中间结果语义。收敛措辞为：只锚定**显式指定的输出文件名/位置**，并明确「中间结果在上下文中传递，不要当成文件去找」。TaskJudge 同步限定为「最终交付物」判据。

**相关文件**：`packages/agent-core/src/planning/Planner.ts`、`TaskJudge.ts`

### 遗留观察（未修，供后续参考）

- **幻影首计划**：四轮运行中首个 plan 均是对长指令的误读（如「搜索多阶段复杂任务的含义」），通常被 Judge 立刻 replan 丢弃，但第三轮浪费了 3 次真实工具调用。根因是弱模型对长结构化中文指令的首遍理解，建议用 `PLANNING_MODEL` 配更强模型。
- **Judge 无法识别内容编造**：第二轮运行中主 agent 未读任何源文件却写出形式完整的报告，Judge 判 complete。形式判据挡不住语义造假。
- **聚合类子任务迭代偏紧**：combine 子 agent 需要 11 次工具调用但 `maxToolIterations=6`，两次因此失败（靠 replan 兜底收敛）。可考虑子 agent 默认迭代次数与主 agent 解耦。

**验证**：`pnpm build` + 356 测试全绿；第四轮真实运行端到端成功（并行波次 1ms 内同时启动、REPORT.md 内容真实、位置正确）。

---

## 八、P0 止血：规划循环、上下文与迁移（2026-07-17）

**背景**：全面代码审查（`docs/feature-review-2026-07.md`）发现 10 个 P0 正确性缺陷，本批修复其中改动小、收益最大的 4 个。

### 1. replan 预算耗尽时失败步骤被静默标记 completed

**问题**：`runPlanningLoop` 中 `executionResult.next === 'replan'` 且 replan 预算耗尽时，守卫条件不通过、retry 分支不匹配，控制流 fall-through 到 `unit.step.status = 'completed'`——失败步骤被当作成功推进，最终以"成功"收尾。原有注释声称防的就是这件事，但只挡住了 retry 路径。

**修复**：与 retry 守卫对称补 replan 守卫（`if (executionResult.next === 'replan') return this.finalizeAnswer();`），失败步骤保持 `failed`，finalize 如实向用户说明。

**相关文件**：`packages/agent-core/src/agents/AgentLoop.ts`

### 2. 未配对的 tool_calls 污染对话历史

**问题**：`executeStep` 在执行前把带 `tool_calls` 的 assistant 消息写入 context，之后两条提前 return 路径留下无 `tool` 响应的调用：①偏离路径（校验不通过，所有调用未执行）；②多调用时首个失败即 return（后续调用未执行）。严格 OpenAI 兼容端点会拒绝后续所有请求（"assistant message with tool_calls must be followed by tool messages"），一次工具偏离等价于整轮 fatal。

**修复**：return 前为未执行的调用补占位 `tool` 消息（偏离路径补全部，失败路径补首个失败之后的全部，content 如实标注未执行原因）。占位消息只进 context 并随持久化保存（保证恢复后的历史同样配对），不 emit `tool_result` 事件、不写 `toolCallStore`，避免污染 trace 与 eval 断言。`runSimpleLoop` 无此问题（所有调用执行完才继续），未动。

**相关文件**：`packages/agent-core/src/agents/AgentLoop.ts`

### 3. 摘要失败永久销毁历史

**问题**：`ContextManager.summarize` 吞掉所有错误返回 `"Summary unavailable: <err>"` 字符串，两条 build 路径把它当正式摘要存储并推进 `lastSummarizedIndex`——一次瞬时 API 错误就不可逆地把一段历史替换成错误串，且永不重试。

**修复**：`summarize` 失败改为抛错；两条 build 路径的重复摘要块抽为共用的 `trySummarizeUpTo(index)`：失败时不推进 `lastSummarizedIndex`、不动现有摘要，本轮仅用 recent window 返回（损失一轮老上下文，历史保留），下一轮 build 自动重试。

**相关文件**：`packages/agent-core/src/context/ContextManager.ts`

### 4. tasks.idempotency_key 老库迁移失败

**问题**：迁移用 `ALTER TABLE tasks ADD COLUMN idempotency_key TEXT UNIQUE`——SQLite 禁止 ALTER 加 UNIQUE 列，错误被裸 catch 吞掉，老库永远没有该列，`SqliteTaskStore.create` 的 INSERT 运行时抛 "no such column"。且 `INIT_SQL` 里 `CREATE INDEX idx_tasks_idempotency_key` 对无该列的旧表同样会抛错。

**修复**：ALTER 去掉 UNIQUE 改为普通列，唯一性用部分唯一索引保证（`CREATE UNIQUE INDEX ... WHERE idempotency_key IS NOT NULL`）；`INIT_SQL` 删除与该约束冗余的 `idx_tasks_idempotency_key`（新库由表定义 UNIQUE 保证，索引后移到迁移段统一创建）。

**相关文件**：`packages/agent-core/src/db/connection.ts`

### 测试与验证

- 新增/更新测试：`planning-agent-loop.test.ts` +3（replan 预算耗尽不伪装成功、偏离路径配对、跳过调用配对）、`ContextManager.test.ts` 改写 1 + 新增 1（失败不存错误串、下轮重试覆盖失败区间）、新增 `tests/db/migration.test.ts`（旧 schema 迁移 + 幂等去重 + 唯一约束生效）
- `pnpm test` 全套 361 通过（agent-core 265 / cli 27 / api 60 / trace-web 9）；`pnpm eval` 30 通过；CLI eval 20/20（含 replan-scenario）

---

## 九、成本优化 A 区：Judge 调用、usage 记账、trace 写入（2026-07-17）

**背景**：审查与功能测试确认规划模式 token 成本过高（Judge 每步全量历史重发 = 二次方成本；辅助调用不记账；trace 每 token 一行）。本批四项均为纯成本优化，不改变正确性语义。

### 1. Judge 短路（A1）

**修改**：
- `executeStep`：满足 `toolName` 约束且成功的步骤已被工具约束机械校验，跳过 Judge；无约束步骤保留语义判定。
- `runPlanningLoop` 计划收尾：全部步骤（递归含 children）completed 时直接 finalize，不再做一次全量历史 Judge 调用。失败/偏离路径的 Judge 全部保留。

**效果**：受约束步骤占多数的规划运行中 Judge 调用归零（此前每步一次）。四个 planning 场景与 planning-agent-loop 测试的 mock 序列按新调用序重写（断言不变或加强）。

### 2. Judge prompt 截断（A1 配套）

**修改**：`TaskJudge.buildPrompt` 对 thought/action/observation/reflection 每个字段截断至 800 字符，消除"整个文件内容随每次判定重发"。

### 3. 辅助调用 usage 全记账（A2）

**修改**：`Planner`/`TaskJudge` 新增 `onUsage` 挂点，`AgentLoop` 构造时统一接线；auto 分类器直接记账。均以 `trackPromptSize: false` 累计（不进上下文估算锚点）。此前 planner/judge/分类器的 token 完全不计入 `tokenUsage`，成本被系统性低估。

**测试**：planning-agent-loop 新增记账用例（110+220+330+440 精确断言总 token）。

### 4. 层级计划父步骤容器化（A4）

**修改**：后序执行中父步骤在 children 完成后自动 completed，不再作为普通步骤重复执行（此前嵌套计划双倍模型调用）。子步骤失败时的既有处理不变。

**测试**：hierarchical 用例改为断言父步骤零工具调用完成（toolCalls 4→3）。

### 5. trace delta 聚合写入（A3）

**修改**：`emitEvent` 对 `message_delta`/`reasoning_delta` 在内存缓冲，遇非 delta 事件或 run 结束（finally）时按流合并为一行落库。此前每个 token 一行 SQLite 写入（长回答数千行），写放大且拖慢全部 trace 查询。实时事件流（emitter）不受影响。

**测试**：agent-loop-trace 新增用例（3 个 token delta → 恰好 1 行聚合记录且内容完整）。

**回归**：全套 381 测试 + eval 30 + build 全绿。
