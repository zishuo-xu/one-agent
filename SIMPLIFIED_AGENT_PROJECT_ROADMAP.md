# 简化版 Agent 项目学习路线

## 目标

实现一个小型 Agent 协作平台，理解并复现 `clowder-ai` 的核心思想，而不是复制整个项目。

```text
用户 → API → Router → Agent → Tool → 持久化 → WebSocket
```

建议使用 TypeScript，因为它与 `clowder-ai` 的技术栈一致。

## 阶段 1：单 Agent

实现：

```text
用户输入 → 调用模型 → 返回回答
```

学习 API 调用、message history、system prompt、环境变量、错误处理和基础测试。

产出：`POST /api/chat`。

## 阶段 2：Tool Calling

实现：

```text
用户问题 → Agent 判断 → 执行工具 → 返回工具结果 → 最终回答
```

先实现 `get_weather` 和 `search_knowledge` 两个工具。

学习工具 schema、参数校验、工具异常、最大循环次数、timeout 和 tool result。

建议拆分为：

```text
AgentLoop
ToolRegistry
ToolExecutor
```

## 阶段 3：Agent Router

实现两个 Agent：

```text
@researcher 负责资料搜索
@coder       负责代码分析
```

Router 支持显式 `@mention`、任务类型自动选择、未知 Agent 错误和单请求路由。

这一阶段对应学习 `clowder-ai` 的 Agent 注册表和 mention routing。

## 阶段 4：Agent Handoff

```text
researcher → 整理资料 → handoff 给 coder → coder 生成方案
```

```ts
interface HandoffRequest {
  fromAgent: string;
  toAgent: string;
  task: string;
  context: string;
  expectedOutput: string;
}
```

必须限制最大 handoff 次数，禁止循环交接，记录失败和每次交接日志。

## 阶段 5：持久化

先使用 SQLite，建立：

```text
users / threads / messages / tasks / agent_runs / tool_calls
```

学习 Thread 与 Message 的关系、Task 生命周期、Agent run 记录、失败恢复和历史查询。

任务状态：`pending`、`running`、`completed`、`failed`、`cancelled`。

## 阶段 6：任务队列

```text
POST /tasks → 创建任务 → 放入队列 → 立即返回 taskId → 后台执行
```

先实现内存队列，再考虑 Redis：

```text
TaskQueue
QueueWorker
TaskStatusStore
```

学习并发限制、取消、timeout、失败、重试和幂等，理解 `clowder-ai` 的 `InvocationQueue` 与 `QueueProcessor`。

## 阶段 7：WebSocket

定义运行事件：

```text
task.started → tool.started → tool.completed → message.delta → task.completed
```

前端处理流式文本、重复事件、断线重连、任务完成状态和旧任务迟到事件。简化版先只支持一个线程。

## 阶段 8：Trace 与 Evaluation

记录：

```text
runId / taskId / agentId / model / startTime / endTime
toolCalls / status / error
```

准备 20 条固定测试任务，检查任务是否完成、是否调用正确工具、是否有无效参数、是否超时、是否发生错误 handoff。

## 最终架构

```text
React Web
   ├─ HTTP：创建任务、查询历史
   └─ WebSocket：运行事件
          ↓
Fastify API
   ├─ Task Routes
   ├─ Agent Router
   ├─ Task Queue
   ├─ Agent Loop
   ├─ Tool Registry
   ├─ Handoff Manager
   ├─ Trace Store
   └─ Evaluation Runner
          ↓
SQLite：messages / tasks / agent_runs / tool_calls
```

## 推荐开发顺序

```text
1. 单 Agent
2. Tool Calling
3. Agent Router
4. Agent Handoff
5. SQLite 持久化
6. Task Queue
7. WebSocket
8. Trace
9. Evaluation
10. Docker 和部署
```

每完成一个阶段提交一次 Git，例如：

```text
feat: add basic agent loop
feat: add tool registry
feat: add agent router
feat: add agent handoff
feat: persist task runs
feat: add task queue
feat: add websocket events
feat: add agent evaluation
```

## 简历表达

> 设计并实现一个简化版多 Agent 协作平台，支持任务路由、工具调用、Agent handoff、异步任务队列、SQLite 持久化、WebSocket 流式事件和 Agent 运行评估。
