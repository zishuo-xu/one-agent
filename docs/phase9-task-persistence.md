# Phase 9：任务持久化与重启恢复

**日期**：2026-07-13  
**项目**：one-agent  
**状态**：✅ 已实现

---

## 目标

把 Phase 6 的内存任务队列持久化到 SQLite，让 API 重启后不会丢失未完成的 `pending` / `running` 任务，并在启动后自动恢复、重新派发。

```text
API 运行中：用户创建任务 -> TaskQueue -> SqliteTaskStore -> 后台执行
API 重启后：读取 tasks 表 -> 把 running 重置为 pending -> restore 到 TaskQueue -> 重新派发
```

---

## 技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 存储位置 | SQLite `tasks` 表 | 与现有持久化层一致，无需 Redis |
| 事件存储 | `tasks.events` JSON 列 | 实现简单，适合当前事件量；量大后可拆 `task_events` 表 |
| 默认 store | 保留内存 `TaskStatusStore` | 不破坏现有核心测试和轻量使用场景 |
| DB store | 新增 `SqliteTaskStore` | API 启动时注入，统一管理任务生命周期 |
| running 任务恢复 | 重置为 `pending` 后重新执行 | 之前的 `AgentLoop` 已随进程结束，无法恢复中间状态 |
| 查询能力 | 保留 `list` / `listByThread` / `listByStatus` | 支持 API 历史任务查询 |

---

## 新增/改造模块

### 1. `tasks` 表

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  reply TEXT,
  error TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_thread_id ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at ON tasks(status, created_at);
```

- 位于 `packages/agent-core/src/db/connection.ts` 的 `INIT_SQL` 和 `packages/agent-core/src/db/migrations/002-tasks.sql`。

### 2. `TaskStore` 接口

```ts
export interface TaskStore {
  create(input: CreateTaskInput): Task;
  get(id: string): Task | undefined;
  getOrThrow(id: string): Task;
  update(id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>): Task;
  setStatus(id: string, status: TaskStatus): Task;
  appendEvent(id: string, event: AgentLoopEvent): Task;
  listByThread(threadId: string): Task[];
  listByStatus(statuses: TaskStatus[]): Task[];
  list(): Task[];
}
```

- `packages/agent-core/src/tasks/types.ts` 定义接口。
- `TaskStatusStore` 继续作为默认内存实现。
- `SqliteTaskStore` 作为持久化实现。

### 3. `SqliteTaskStore`

`packages/agent-core/src/db/taskStore.ts`：

- 遵循现有 store 模式：私有 `TaskRow`（snake_case）+ `rowToTask()` 转换。
- `events` 列使用 `JSON.stringify` / `JSON.parse` 读写。
- `appendEvent` 读取当前任务事件数组，追加后整列更新。
- `listByStatus` 使用 `WHERE status IN (...)` 动态占位符。

### 4. `TaskQueue` 改造

`packages/agent-core/src/tasks/TaskQueue.ts`：

- `TaskQueueOptions` 增加 `store?: TaskStore`，默认使用 `TaskStatusStore`。
- 所有状态变更通过 `this.store.*` 完成。
- `acquireNext()` 中刷新 `entry.task` 为 store 最新状态，避免内存对象和 DB 不同步。
- `cancel()` 从 store 获取最新任务后再 emit，保证事件对象状态一致。
- 新增 `restore(task: Task)`：把已持久化任务载入内存队列，不新建 DB 记录。

### 5. API 启动恢复

`apps/api/src/routes/tasks.ts`：

```ts
const taskStore = new SqliteTaskStore(db);
const taskQueue = new TaskQueue({ store: taskStore, maxConcurrency: 2 });

for (const task of taskStore.listByStatus(['pending', 'running'])) {
  if (task.status === 'running') {
    taskStore.setStatus(task.id, 'pending');
  }
  const fresh = taskStore.get(task.id)!;
  taskQueue.restore(fresh);
}

worker.start();
```

### 6. API 路由扩展

保留原有接口，新增 `GET /api/tasks`：

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 创建任务，支持 `idempotencyKey` 幂等；重复提交返回同一任务 |
| GET | `/api/tasks` | 列出所有历史任务 |
| GET | `/api/tasks/:id` | 查询任务状态与结果 |
| GET | `/api/tasks/:id/events` | SSE 流式事件 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| POST | `/api/tasks/:id/retry` | 手动重试死信任务 |

---

## 测试覆盖

```text
packages/agent-core/tests/db/taskStore.test.ts
packages/agent-core/tests/tasks/persistentTaskQueue.test.ts
apps/api/tests/task-routes.test.ts
```

- `SqliteTaskStore` 单测：创建、查询、更新、事件追加、按状态/线程筛选。
- 持久化队列测试：任务通过队列完成时落盘、restore 后重新派发、事件写入。
- `task-routes.test.ts`：增加死信列表查询、手动重试、超时失败等场景。

---

## 手动验证步骤

1. 启动 API：

   ```bash
   pnpm dev:api
   ```

2. 创建任务：

   ```bash
   curl -X POST http://localhost:3000/api/tasks \
     -H 'Content-Type: application/json' \
     -d '{"message": "帮我列出当前目录的 txt 文件"}'
   ```

3. 在任务执行过程中（pending / running）关闭 API，再重新启动。

4. 查询任务状态，应看到任务被重新执行并变为 `completed`：

   ```bash
   curl http://localhost:3000/api/tasks/<task-id>
   ```

---

## 关键实现细节

1. **内存对象与 DB 同步**  
   `TaskQueue` 内部维护 `Map` 和 `pending`/`running` 集合仅用于调度；真实状态以 DB 为准。

2. **restore 不创建新记录**  
   `restore(task)` 只是把已存在的任务重新加入调度队列，避免重启后重复写入 DB。

3. **running 任务无法恢复中间状态**  
   进程重启后旧的 `AgentLoop` 实例已消失，因此 running 任务统一重置为 pending，由新 worker 重新执行整条消息。

4. **Trace 与任务关联**  
   `AgentLoop` 在创建 `agent_runs` 记录时写入 `task_id`，`trace_events` 也保存 `task_id`，可完整追踪某任务的事件流。

5. **重试与死信**  
   `TaskQueue` 支持 `maxRetries` 与 `retryDelayMs`，`QueueWorker` 用指数退避自动重试失败任务；超过最大次数后进入 `dead_letter` 状态，可通过 `POST /api/tasks/:id/retry` 手动重试。`tasks` 表通过 `retry_count` 与 `failed_reason` 记录相关信息。

---

## 相关文档

- `docs/optimization-notes.md`
- `docs/phase6-async-streaming.md`
- `docs/phase7-trace-evaluation.md`
- `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`

---

## 下一步

Phase 10：长期记忆检索。
