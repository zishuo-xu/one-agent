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

## 阶段 3：上下文与记忆管理

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

## 阶段 4：规划与自我纠错

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

## 阶段 5：SQLite 持久化

把内存里的对话和运行记录落盘。

```text
threads / messages / tool_calls / agent_runs
```

学习 Thread 与 Message 的关系、Agent run 记录、失败恢复和历史查询。

任务状态：`pending`、`running`、`completed`、`failed`、`cancelled`。

## 阶段 6：异步任务与流式输出

```text
POST /tasks -> 创建任务 -> 放入队列 -> 立即返回 taskId -> 后台执行 + 流式推送
```

先内存队列，再考虑 Redis。

```text
TaskQueue / QueueWorker / TaskStatusStore
```

流式事件：

```text
task.started -> tool.started -> tool.completed -> message.delta -> task.completed
```

学习并发限制、取消、timeout、重试、幂等，以及 SSE/WebSocket 流式文本与断线重连。

## 阶段 7：Trace 与 Evaluation

记录：

```text
runId / taskId / model / startTime / endTime
toolCalls / status / error / 推理链
```

准备 20 条固定测试任务，检查：任务是否完成、是否调用正确工具、参数是否有效、是否超时、规划是否合理。

## 阶段 8：Docker 与部署

容器化 Agent + API，环境隔离，可复现部署。

## 最终架构

```text
React Web / CLI
   ├─ HTTP：创建任务、查询历史
   └─ SSE/WebSocket：运行事件 + 流式文本
          ↓
Fastify API
   ├─ Task Routes
   ├─ Task Queue
   ├─ Agent Loop（规划 / 工具 / 自纠）
   ├─ Tool Registry
   ├─ Context Manager（记忆 / 摘要）
   ├─ Trace Store
   └─ Evaluation Runner
          ↓
SQLite：threads / messages / tool_calls / agent_runs
```

## 推荐开发顺序

```text
1. 单 Agent ✅
2. Tool Calling ✅
3. 上下文与记忆管理
4. 规划与自我纠错
5. SQLite 持久化
6. 异步任务与流式输出
7. Trace
8. Evaluation
9. Docker 与部署
```

每完成一个阶段提交一次 Git：

```text
feat: add context manager with summarization
feat: add planning and self-correction loop
feat: persist threads and runs to sqlite
feat: add async task queue and streaming
feat: add run tracing
feat: add agent evaluation
```

## 简历表达

> 设计并实现一个 Agent 运行时，支持工具调用、上下文记忆管理、规划与自我纠错、异步任务队列、SQLite 持久化、流式输出和运行评估，深入理解单 Agent 的完整生命周期。
