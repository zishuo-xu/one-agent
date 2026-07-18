# 简化版 Agent 项目学习路线

## 目标

实现并吃透**一个** Agent 的完整内核，理解 Agent 的核心机制（循环、工具、记忆、规划、持久化、流式、评估），而不是堆砌多 Agent 编排。

```text
用户 -> AgentLoop -> [规划 -> 工具 -> 观察] -> 记忆/持久化 -> 流式输出
```

技术栈：TypeScript + pnpm workspace。

> 说明：本路线图早期版本照搬了 `clowder-ai` 的多 Agent 路线（Router / Handoff），
> 与项目名 `one-agent` 的初衷冲突。第 3 阶段起改为深化单 Agent。

## 阶段 1：单 Agent ✅

```text
用户输入 -> 调用模型 -> 返回回答
```

学习 API 调用、message history、system prompt、环境变量、错误处理和基础测试。

产出：`POST /api/chat` + CLI REPL。

## 阶段 2：Tool Calling ✅

```text
用户问题 -> Agent 判断 -> 执行工具 -> 返回工具结果 -> 最终回答
```

已实现 `read_file` / `write_file` / `list_files` / `get_time`。

学习工具 schema、参数校验、工具异常、最大循环次数、timeout 和 tool result。

结构：`AgentLoop` / `ToolRegistry` / `ToolExecutor` / `Sandbox`。

## 阶段 3：上下文与记忆管理 ✅

解决"对话变长后上下文爆掉"的问题。

```text
对话增长 -> 超过阈值 -> 摘要旧消息 -> 保留近期消息 + 摘要 -> 继续
```

学习点：

- token 计数与上下文窗口感知
- 滑动窗口（保留 system + 最近 N 条）
- 对话摘要压缩（把旧消息压成一条 summary）
- （可选）长期记忆：把事实写入 workspace 文件或 KV，按需检索

产出：`ContextManager`，AgentLoop 接入后支持长对话不崩。

## 阶段 4：规划与自我纠错 ✅

让 Agent 从"被动调用工具"升级为"先规划再执行，失败能自纠"。

```text
复杂任务 -> 拆解为计划 -> 逐步执行 -> 观察结果 -> 偏差则反思重试
```

学习点：

- 显式规划：先输出计划，再按计划执行
- ReAct 思路：Thought -> Action -> Observation 显式化
- 自我纠错：工具失败或结果不符时，反思并换方案
- 任务完成判定：不只是"模型不再调工具"，而是"目标达成"

产出：AgentLoop 升级支持 planning + reflection，记录推理链。

## 阶段 5：SQLite 持久化 ✅

把内存里的对话和运行记录落盘。

```text
threads / messages / tool_calls / agent_runs
```

学习 Thread 与 Message 的关系、Agent run 记录、失败恢复和历史查询。

任务状态：`pending`、`running`、`completed`、`failed`、`cancelled`。

## 阶段 6：异步任务与流式输出 ✅

```text
POST /tasks -> 创建任务 -> 放入队列 -> 立即返回 taskId -> 后台执行 + 流式推送
```

先内存队列，再考虑 Redis。

```text
TaskQueue / QueueWorker / TaskStatusStore
```

流式事件：

```text
task.created -> task.started -> plan -> thought -> tool_call -> tool_result -> message.delta -> task.completed
```

已实现 SSE 任务事件流与 CLI 实时事件输出。

学习并发限制、取消、timeout、重试、幂等，以及 SSE/WebSocket 流式文本与断线重连。

## 阶段 7：Trace 与 Evaluation ✅

记录：

```text
runId / taskId / model / startTime / endTime
toolCalls / status / error / 推理链
```

已新增 `trace_events` 表保存完整事件流，并可用 `EvalRunner` 跑确定性回归测试。

准备 20 条固定测试任务，检查：任务是否完成、是否调用正确工具、参数是否有效、是否超时、规划是否合理。

## 阶段 8：全局 CLI 命令 ✅

把 CLI 打包成可全局安装的命令行工具：

```bash
npm install -g @one-agent/cli
one-agent
```

已支持工作目录解析、`.env` 从工作目录加载、默认 `~/.one-agent`。

## 阶段 9：任务持久化 ✅

把 Phase 6 的内存任务队列落盘，让 API 重启后自动恢复未完成任务。

```text
tasks 表保存 task 状态、事件流
API 启动时：pending / running 任务 restore 到 TaskQueue
running 任务重置为 pending 后重新执行
```

产出：`SqliteTaskStore`、`TaskQueue` 支持注入 store、`GET /api/tasks`、API 启动恢复。

## 阶段 10：长期记忆检索 ✅

让独立 Memory Agent 按完整会话整理并跨 thread 召回可信长期事实。

```text
memories 表保存全局事实
切换/退出时整理当前 Thread，启动时恢复未提取 Thread
只以用户消息为证据，并按原始消息时间解决冲突
新提问按关键词召回并注入上下文
```

产出：`MemoryStore`、`MemoryExtractor`、`MemoryConsolidator`、可恢复会话状态、跨 thread 记忆共享、记忆管理 API、
召回决策 Trace 与 `memory-recall-v1` 离线评测基线。

## 最终架构

```text
CLI / REST API / Trace Viewer（只读）
   ├─ HTTP：创建任务、查询历史
   ├─ SSE：任务事件 + 流式文本
   └─ Trace Viewer：读取运行事实，不触发执行或验证
          ↓
Fastify API
   ├─ Task Routes
   ├─ Task Queue
   ├─ AgentLoop 门面
   │    ├─ SimpleLoop（直接回答 / 工具循环）
   │    └─ PlanningLoop（规划 / 工具 / Judge / 重规划）
   ├─ Tool Registry
   ├─ Context Manager（记忆 / 摘要）
   ├─ Trace Store
   ├─ Task Store
   ├─ Memory Store
   └─ Evaluation Runner
          ↓
SQLite：threads / messages / tool_calls / agent_runs / tasks / trace_events / memories
```

## 已完成的核心开发顺序

```text
1. 单 Agent ✅
2. Tool Calling ✅
3. 上下文与记忆管理 ✅
4. 规划与自我纠错 ✅
5. SQLite 持久化 ✅
6. 异步任务与流式输出 ✅
7. Trace ✅
8. Evaluation ✅
9. 全局 CLI 命令 ✅
10. 任务持久化 ✅
11. 长期记忆检索 ✅
12. 规划增强与模型抽象 ✅
13. 工具生态与受限子 Agent ✅
14. Trace / Eval 联动与子 Agent 观测 ✅
15. 能力评测基线与四并发运行 ✅
16. 会话级记忆治理与召回可解释性 ✅
17. PlanningLoop 断点恢复 v1 ✅
```

每完成一个阶段提交一次 Git：

```text
feat: add context manager with summarization
feat: add planning and self-correction loop
feat: persist threads and runs to sqlite
feat: add async task queue and streaming
feat: add run tracing
feat: add agent evaluation
feat: add global CLI command
feat: persist task queue to sqlite for restart recovery
feat: add session-level memory consolidation and retrieval
```

## 后续通用能力候选（未实现）

相比继续增加业务工具，当前更值得研究的通用 Agent 方向是“显式工作状态 + 自适应执行策略”：

- `WorkingState / Blackboard` 统一保存目标、约束、证据事实、假设、未解决问题、失败尝试和下一步意图；
- `Strategy Controller` 根据复杂度、不确定性、工具反馈与预算，在直接执行、规划、假设验证和反思策略之间切换；
- 状态变化和策略切换进入 Trace，供开发人员分析，但 Runtime 不根据 Trace 自动修改自己。

该方向目前只是设计候选，尚未进入实现。应先定义最小状态结构和可评价场景，再决定是否开发；当前事实以
[项目目标、愿景与设计现状](./docs/project-vision-and-status.md)为准。

## 简历表达

> 设计并实现一个 Agent 运行时，支持工具调用、上下文记忆管理、规划与自我纠错、异步任务队列、SQLite 持久化、流式输出和运行评估，深入理解单 Agent 的完整生命周期。
