# 核心正确性修复

**日期**：2026-07-14
**范围**：`packages/agent-core`、`apps/cli`
**目标**：修复 review 指出的五处核心正确性问题。

---

## 一、默认聊天路径其实不是真流式

**问题**：默认（非 planning）路径下 `runSimpleLoop` 用非流式 `callModel()` 拿到完整响应后才 `streamFinalAnswer()` 一次性 emit 全文。CLI 虽逐 delta 打印，但 delta 本身只有一条整段文本，用户体感仍是"等几秒后一次性显示"——这正是"你好为什么慢"的根因。

**修复**：
- `runSimpleLoop` 探测阶段仍用非流式 `callModel()`（需要整体拿到 `tool_calls` 才能决定是否调用工具）。
- 一旦确认本轮无工具调用，交给新的 `streamFinalAnswerOrProbe()`：
  - 若探测阶段已经返回内容（含 `reasoning_content` 回退），直接 emit 为 delta，避免二次请求。
  - 否则发起真正的 `streamModel({ includeTools: false })` 流式补全，逐 token 产生 `message_delta`。
- 工具调用阶段保持非流式，不变。

**相关文件**：
- `packages/agent-core/src/agents/AgentLoop.ts`（`runSimpleLoop`、`streamFinalAnswerOrProbe`）
- `packages/agent-core/tests/correctness-fixes.test.ts`

**验证**：
- 探测返回空内容时，第二次 `create` 调用带 `stream:true` 且产出 `['Hel','lo']` 两条 delta。
- 探测已返回内容时，只调用一次模型，不二次请求。
- 探测仅返回 `reasoning_content` 时也能正确复用。

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

## 六、验证结果

- `pnpm build` 通过。
- `pnpm test` 全绿：
  - `agent-core`：32 文件 / 166 测试（含新增 `tests/correctness-fixes.test.ts` 6 个）
  - `api`：4 文件 / 27 测试
  - `cli`：8 文件 / 57 测试
  - `trace-web`：1 文件 / 7 测试