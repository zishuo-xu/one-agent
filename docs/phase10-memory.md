# Phase 10：长期记忆检索

**日期**：2026-07-13  
**项目**：one-agent  
**状态**：✅ 已实现

---

## 目标

让 Agent 在每次对话后自动提取关键事实，并在后续用户提问时把这些事实召回注入上下文，实现跨 thread 的长期记忆。

```text
第一轮：用户说“我喜欢中文” -> Agent 回复 -> 自动提取记忆
第二轮（新 thread）：用户问“用我喜欢的语言打招呼” -> Agent 召回“中文”偏好 -> 用中文回复
```

---

## 技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 存储载体 | SQLite `memories` 表 | 与现有持久化层一致，无需额外依赖 |
| 检索方式 | 关键词 LIKE 匹配（按 key/value） | 无需 embedding，实现简单，适合学习项目 |
| 上下文注入 | 在 `ContextManager` 的 system prompt 后插入记忆片段 | 影响所有 LLM 调用，不破坏现有消息流 |
| 规划感知 | 把相关记忆文本传入 `Planner.createPlan` | 让计划阶段也能利用历史知识 |
| 写入时机 | 自动提取 | 每轮运行结束后由 `MemoryExtractor` 调用模型提取 JSON 事实 |
| 作用范围 | 全局共享 | 不局限于当前 thread |
| 数量限制 | 默认最多召回 5 条 | 控制 token 开销 |

---

## 数据模型

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  thread_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
```

---

## 新增模块

```text
packages/agent-core/src/
├── db/migrations/003-memories.sql
├── db/memoryStore.ts              # MemoryStore 持久化
├── db/types.ts                    # Memory / CreateMemoryInput
├── memory/MemoryExtractor.ts      # 从对话中提取关键事实
├── context/ContextManager.ts      # 支持 memoryContext 注入
├── planning/Planner.ts            # createPlan 接受 memories 参数
├── agents/AgentLoop.ts            # 召回记忆、调用提取器
└── index.ts                       # 导出 MemoryStore、MemoryExtractor、类型

apps/api/src/
├── routes/memory.ts               # 记忆管理路由
└── server.ts                      # 注册 memoryRoutes
```

---

## 关键实现细节

### 1. `MemoryStore`

- 遵循现有 store 模式，提供 `create`、`getById`、`list`、`getRelevantMemories`、`update`、`deleteById`。
- `getRelevantMemories(query, limit = 5)` 拆分查询词，过滤停用词，使用 `LIKE` 匹配 `key`/`value`，按 `updated_at` 排序返回前 N 条。
- 记忆全局共享，但可保留 `thread_id` 作为来源审计。

### 2. `MemoryExtractor`

```ts
extract(userMessage: string, assistantReply: string): Promise<{ key: string; value: string }[]>
```

- 使用 `config.openai.chat.completions.create` 调用模型。
- Prompt 要求返回 JSON 数组：`[{ "key": "...", "value": "..." }]`。
- 解析失败或模型异常时返回空数组，**不影响主流程**。

### 3. `ContextManager` 注入记忆

新增 `memoryContext` 字段和 `setMemoryContext(content)`：

- `buildContext()` 和 `getContextForDisplay()` 在 system prompt 后插入一条 system 消息，展示相关记忆。
- 无记忆时行为完全不变。

### 4. `AgentLoop` 集成

`chat(message)` 流程：

1. 添加用户消息后，调用 `memoryStore.getRelevantMemories(message)` 召回相关记忆。
2. 如果有记忆，通过 `contextManager.setMemoryContext(...)` 注入上下文。
3. 规划阶段把记忆文本传给 `Planner.createPlan`。
4. 运行成功后，用 `memoryExtractor.extract(message, reply)` 提取事实并写入 `MemoryStore`。

---

## API 路由

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/memories` | 手动创建记忆（调试用） |
| GET | `/api/memories` | 列出所有记忆，可传 `?query=...` 做关键词召回 |
| GET | `/api/memories/:id` | 查询单条记忆 |
| DELETE | `/api/memories/:id` | 删除记忆 |

---

## 测试覆盖

```text
packages/agent-core/tests/db/memoryStore.test.ts
packages/agent-core/tests/context/ContextManager-memory.test.ts
packages/agent-core/tests/memory/extractor.test.ts
packages/agent-core/tests/db/persistence-memory-integration.test.ts
apps/api/tests/memory-routes.test.ts
```

---

## 手动验证

1. 启动 API：

   ```bash
   pnpm dev:api
   ```

2. 告诉 Agent 一个偏好：

   ```bash
   curl -X POST http://localhost:3000/api/chat \
     -H 'Content-Type: application/json' \
     -d '{"message": "我喜欢用中文交流"}'
   ```

3. 查看记忆是否被写入：

   ```bash
   curl http://localhost:3000/api/memories
   ```

4. 新建 thread（或清掉当前对话），问相关的问题：

   ```bash
   curl -X POST http://localhost:3000/api/chat \
     -H 'Content-Type: application/json' \
     -d '{"message": "请用我喜欢的语言说你好"}'
   ```

   应观察到 Agent 使用中文回复。

---

## 当前局限与后续优化

1. **关键词召回精度有限**  
   目前使用简单的 `LIKE` 匹配。后续可引入 embedding + 向量检索（如 `sqlite-vec` 或专用向量库）。

2. **记忆冲突未处理**  
   如果同一 key 出现矛盾的新事实，目前是独立写入，不会自动合并或覆盖。

3. **提取质量依赖模型**  
   当前 `glm-5.2` 对 JSON 输出稳定性一般，已做 markdown 代码块剥离和解析失败回退。

4. **隐私与范围控制**  
   当前记忆全局共享。未来可支持按用户/session 隔离，或提供 `/forget` 命令。

---

## 相关文档

- `docs/optimization-notes.md`
- `docs/phase6-async-streaming.md`
- `docs/phase9-task-persistence.md`
- `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`

---

## 下一步

Phase 11：Docker 与部署。
