# Phase 5：SQLite 持久化

> 文档状态：历史阶段快照（非当前数据库规范）
> 阅读说明：本文记录最初四表持久化设计；当前数据库已经扩展为七张业务表。最新结构见 [项目现状](./project-vision-and-status.md)，分类规则见 [文档索引](./README.md)。

**日期**：2026-07-13  
**项目**：one-agent  
**状态**：✅ 已实现

---

## 一、核心目标

把原本存在于内存中的 `threads`、`messages`、`agent_runs`、`tool_calls` 持久化到 SQLite，让 Agent 具备跨会话记忆和运行复盘能力。

```text
threads       -> 会话线程
messages      -> 每个线程的消息历史
agent_runs    -> 每次 Agent 运行的元数据和推理链
tool_calls    -> 每次工具调用的参数和结果
```

---

## 二、技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 数据库 | SQLite + `better-sqlite3` | 轻量、零配置、TypeScript 友好 |
| 数据库文件 | `workspace/data.db` | 与用户数据放在一起，便于迁移和清理 |
| ORM | 不使用，裸写 SQL | 学习成本低，避免额外依赖 |
| ContextManager | 包装（wrap）而非替换 | 保留现有摘要逻辑，降低风险 |
| thread ID | UUID | 简单、唯一 |
| CLI 默认行为 | 新建 thread | 不带 `--thread` 时创建新会话 |

---

## 三、新增模块

```text
packages/agent-core/src/db/
├── connection.ts              # better-sqlite3 连接 + 迁移
├── migrations/001-init.sql    # 建表文档（connection.ts 使用内联 SQL）
├── threadStore.ts             # thread CRUD
├── messageStore.ts            # message CRUD（按 thread）
├── runStore.ts                # agent_run CRUD
├── toolCallStore.ts           # tool_call CRUD
└── types.ts                   # 类型与转换函数

packages/agent-core/src/context/
└── PersistenceContextManager.ts   # 包装 ContextManager，持久化消息
```

### 表结构

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_thread_id ON messages(thread_id);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  model TEXT NOT NULL,
  start_time DATETIME,
  end_time DATETIME,
  status TEXT,
  error TEXT,
  reasoning_chain TEXT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_runs_thread_id ON agent_runs(thread_id);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments TEXT,
  result TEXT,
  success BOOLEAN,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_tool_calls_run_id ON tool_calls(run_id);
```

---

## 四、集成点

### 1. PersistenceContextManager

- 继承 `ContextManager`
- 重写 `addMessage()`：先调用父类，再写入 SQLite，并更新 thread 时间戳
- 新增 `loadThread(threadId)`：从 DB 加载历史消息到父类消息列表
- 摘要逻辑仍复用父类

### 2. AgentLoop

- 新增 `AgentLoopOptions.threadId?: string` 和 `db?: Database.Database`
- 传入 `threadId` 时自动使用 `PersistenceContextManager` 加载历史
- `chat()` 开始：创建 `agent_runs` 记录，状态 `running`
- `chat()` 结束：更新 `agent_runs` 状态为 `completed` 或 `failed`
- 工具调用后：写入 `tool_calls`
- `ReasoningChain` 序列化后存入 `agent_runs.reasoning_chain`

### 3. CLI

- 启动参数：`--thread <id>` 恢复指定 thread，`--new-thread` 强制新建
- 默认行为：创建新 thread
- 新命令：
  - `/threads`：列出所有 thread
  - `/runs`：列出当前 thread 的所有 run
  - `/thread <id>`：切换到指定 thread

### 4. API

- `POST /api/chat` 请求体：`{ message: string; threadId?: string }`
- 若 `threadId` 存在则加载历史，否则创建新 thread
- 返回：`{ reply, events, threadId }`
- 新增路由：
  - `GET /api/threads`：列出 threads
  - `GET /api/threads/:id/messages`：列出消息
  - `GET /api/threads/:id/runs`：列出 runs
  - `GET /api/runs/:id/tool-calls`：列出 tool calls

---

## 五、任务状态流转

```text
pending -> running -> completed
              |
              -> failed
              |
              -> cancelled
```

---

## 六、测试覆盖

```text
packages/agent-core/tests/db/
├── threadStore.test.ts
├── messageStore.test.ts
├── runStore.test.ts
├── toolCallStore.test.ts
└── persistence-integration.test.ts

apps/api/tests/chat-routes.test.ts
```

---

## 七、手动测试用例

### CLI

```bash
# 1. 启动 CLI，自动创建新 thread
pnpm dev:cli

# 2. 输入消息，观察回复
> 你好

# 3. 查看历史
> /history

# 4. 退出后重启，用 --thread 恢复（从 /history 或 /threads 获取 id）
pnpm dev:cli -- --thread <thread-id>

# 5. 验证历史已加载，继续对话
> 还记得我刚才说了什么吗

# 6. 列出所有 thread
> /threads

# 7. 列出当前 thread 的运行记录
> /runs

# 8. 切换到另一个 thread
> /thread <another-thread-id>

# 9. 强制新建 thread（即使带了 --thread）
pnpm dev:cli -- --thread <id> --new-thread
```

### API

```bash
# 1. 启动 API
pnpm dev:api

# 2. 创建新 thread 并对话
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "你好"}'

# 3. 使用返回的 threadId 继续对话
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "还记得我吗", "threadId": "<thread-id>"}'

# 4. 查询 threads
curl http://localhost:3000/api/threads

# 5. 查询历史消息
curl http://localhost:3000/api/threads/<thread-id>/messages

# 6. 查询 runs
curl http://localhost:3000/api/threads/<thread-id>/runs

# 7. 查询某个 run 的 tool calls
curl http://localhost:3000/api/runs/<run-id>/tool-calls
```

---

## 八、关键实现细节

1. **列名映射**：SQLite 使用 `snake_case`（`created_at`、`thread_id` 等），TypeScript 类型使用 `camelCase`（`createdAt`、`threadId` 等），所有 Store 在读写时做显式转换。

2. **`:memory:` 处理**：`createConnection` 对 `:memory:` 路径做特殊处理，避免被 `path.resolve` 转成普通文件路径导致测试间共享数据库。

3. **WAL 模式**：仅在文件数据库上启用 `journal_mode = WAL`，`:memory:` 数据库跳过 WAL。

4. **boolean 存储**：SQLite 没有原生 boolean，`tool_calls.success` 以 `0`/`1` 存储，读取时转换回 boolean。

5. **依赖注入**：`AgentLoop` 支持传入 `db`/`runStore`/`toolCallStore`/`threadStore`，便于单元测试使用独立数据库。

6. **DB 路径**：CLI 和 API 默认把数据库放在项目根目录 `workspace/data.db`，可通过环境变量 `DATABASE_PATH` 覆盖，且不会覆盖已存在的环境变量值。

---

## 九、相关文档

- `docs/optimization-notes.md`
- `docs/phase4-summary.md`
- `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`

---

## 十、下一步

Phase 6：异步任务与流式输出。
