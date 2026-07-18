# Phase 6：异步任务与流式输出

> 文档状态：历史阶段快照（非当前实现说明）
> 阅读说明：接口、测试数量和“下一步”只代表 Phase 6 完成时。最新事实见 [项目现状](./project-vision-and-status.md)，分类规则见 [文档索引](./README.md)。

**日期**：2026-07-13  
**项目**：one-agent  
**状态**：✅ 已实现

---

## 一、核心目标

让 AgentLoop 从「同步返回完整结果」升级为「边运行边推送事件」，并通过异步任务队列支持后台执行和流式查询。

```text
用户 -> 创建任务 -> 立即返回 taskId
              -> 后台运行 AgentLoop
              -> 通过 SSE 实时推送事件
```

---

## 二、技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 传输协议 | SSE | 单向推送足够，无需额外依赖 |
| 模型流式 | OpenAI `stream: true` | 实现真正的 `message.delta` 事件 |
| 队列 | 内存队列 | 路线图要求先内存，再考虑 Redis |
| 事件机制 | Node.js EventEmitter | 无额外依赖，与 CLI/API 都容易集成 |
| 取消机制 | AbortController | 标准、干净 |
| 模块位置 | `packages/agent-core/src/tasks/` | 核心能力，CLI/API 共享 |

---

## 三、事件流设计

```text
task.created
task.started
  plan
task.running
  thought
  tool_call
  tool_result
  reflection（如需 replan）
  message.delta
  ...
task.completed / task.failed / task.cancelled
```

---

## 四、新增模块

```text
packages/agent-core/src/tasks/
├── types.ts              # Task, TaskStatus, TaskEvent, CreateTaskInput
├── TaskQueue.ts          # 内存队列、并发控制、任务注册/查询/取消
├── TaskStatusStore.ts    # 任务状态存储（内存实现）
└── QueueWorker.ts        # 从队列取任务、驱动 AgentLoop、转发事件
```

### 主要职责

- **TaskQueue**：维护 `pending` 和 `running` 任务集合，支持 `maxConcurrency` 并发控制，提供 `enqueue`、`acquireNext`、`complete`、`fail`、`cancel` 等方法。
- **TaskStatusStore**：内存中存储任务对象，支持状态更新和事件追加。
- **QueueWorker**：监听队列 `ready` 事件，取出任务创建 `AgentLoop` 实例，订阅 `event` 事件并写入队列，任务结束后更新状态。

---

## 五、AgentLoop 改造

`packages/agent-core/src/agents/AgentLoop.ts`：

- 继承 `EventEmitter`，运行中实时 `emit('event', event)`
- 保留原有 `events` 数组，兼容同步返回的旧接口
- 新增 `signal?: AbortSignal` 支持取消
- 规划模式的最终回答使用 `stream: true`，持续 emit `message_delta`，最后 emit `message`

---

## 六、API 路由

`apps/api/src/routes/tasks.ts`：

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 创建任务，支持 `idempotencyKey`，重复提交返回同一任务 |
| GET | `/api/tasks/:id` | 查询任务状态与结果 |
| GET | `/api/tasks/:id/events` | SSE 流式事件 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |

保留现有 `/api/chat` 同步接口不变。

SSE 事件格式：

```text
data: {"type":"agent","event":{"type":"tool_call","toolCall":...}}

data: {"type":"agent","event":{"type":"message_delta","content":"..."}}

data: {"type":"task","status":"completed","reply":"..."}
```

---

## 七、CLI 改造

`apps/cli/src/index.ts`：

- 调用 `agent.on('event', ...)` 实时打印事件
- 用户能看到 `[tool_call]`、`[tool_result]`、`[thought]`、`[reflection]`、`[plan]`、`[message_delta]` 等过程输出

---

## 八、关键实现细节

1. **TaskQueue 返回快照**：`enqueue` 返回任务初始状态的浅拷贝，避免 API 立即返回时状态已被 worker 改为 `running`。
2. **nextTick 调度**：`enqueue` 使用 `process.nextTick` 触发调度，让 API 有机会先返回 pending 状态。
3. **SSE 句柄**：使用 `reply.hijack()` 接管响应，在任务完成/失败/取消时结束连接。
4. **取消传播**：`AgentLoop` 接收 `AbortSignal`，`QueueWorker` 通过 `AbortController` 触发取消，循环中的 `checkSignal()` 会抛出取消错误。
5. **流式兼容**：`streamModel` 同时处理真正的 OpenAI 流式响应和测试中的非流式 mock 响应。

---

## 九、测试覆盖

```text
packages/agent-core/tests/tasks/
├── taskQueue.test.ts
├── queueWorker.test.ts
└── agent-loop-streaming.test.ts

apps/api/tests/task-routes.test.ts
```

---

## 十、手动测试用例

### CLI

```bash
pnpm dev:cli
> 帮我列出当前目录的 txt 文件

# 应该能看到：
# [tool_call] list_files
# [tool_result] ok
# [message_delta] ...（逐步输出）
# Agent: ...
```

### API

```bash
# 1. 创建任务
curl -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"message": "帮我列出当前目录的 txt 文件"}'
# 返回：{"taskId": "...", "status": "pending"}

# 2. 查询任务状态
curl http://localhost:3000/api/tasks/<task-id>

# 3. 订阅 SSE 事件流
curl http://localhost:3000/api/tasks/<task-id>/events

# 4. 取消任务
curl -X POST http://localhost:3000/api/tasks/<task-id>/cancel

# 5. 幂等创建任务（同一 idempotencyKey 只执行一次）
curl -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"message": "帮我列出当前目录的 txt 文件", "idempotencyKey": "list-txt-001"}'
```

---

## 十一、相关文档

- `docs/optimization-notes.md`
- `docs/phase5-persistence.md`
- `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`

---

## 十二、下一步

Phase 7：Trace 与 Evaluation。
