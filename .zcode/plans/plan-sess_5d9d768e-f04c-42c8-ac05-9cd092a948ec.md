# 简化版 Agent 协作平台 — 实施计划

基于 `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`，采用 **pnpm workspace monorepo**，实现「后端 + 最简前端」同步推进。

## 一、仓库结构

```text
one-agent/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── apps/
│   ├── api/                  # Fastify + SQLite + WebSocket 后端
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config.ts
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   ├── agents/
│   │   │   ├── tools/
│   │   │   ├── queue/
│   │   │   ├── db/
│   │   │   ├── trace/
│   │   │   └── eval/
│   │   ├── tests/
│   │   └── package.json
│   └── web/                  # Vite + React + TypeScript 前端
│       ├── src/
│       ├── package.json
│       └── vite.config.ts
└── packages/shared/          # 共享类型和常量（可选）
    ├── src/
    └── package.json
```

## 二、技术栈

- **包管理器**：pnpm
- **后端**：Fastify + `@fastify/websocket` + `better-sqlite3`
- **模型**：OpenAI-compatible SDK（`openai`），支持通过环境变量配置 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`
- **校验**：zod
- **测试**：vitest（后端为主，每个阶段写单元/集成测试）
- **前端**：Vite + React + TypeScript + Tailwind CSS（最简）
- **工具**：tsx 开发热重载、TypeScript 5.x

## 三、分阶段实施

### 阶段 1：单 Agent（feat: add basic agent loop）

目标：`用户输入 → 调用模型 → 返回回答`。

后端：
- `apps/api/src/config.ts`：读取环境变量、模型配置、默认 system prompt。
- `apps/api/src/agents/AgentLoop.ts`：封装 OpenAI SDK 调用，维护 message history，处理错误和重试。
- `apps/api/src/routes/chat.ts`：`POST /api/chat`，请求体 `{ message: string }`。
- 测试：验证正常返回、错误处理、system prompt 生效。

前端：
- `apps/web/src/pages/Chat.tsx`：单输入框 + 对话气泡展示。

### 阶段 2：Tool Calling（feat: add tool registry）

目标：Agent 能判断并调用工具。

后端：
- `apps/api/src/tools/ToolRegistry.ts`：注册工具 schema（zod）。
- `apps/api/src/tools/ToolExecutor.ts`：执行 `get_weather`（模拟）和 `search_knowledge`（本地 SQLite 简单知识库）。
- `apps/api/src/agents/AgentLoop.ts`：升级循环，支持 tool call / tool result 多轮，限制最大循环次数和超时。
- 测试：验证工具参数校验、工具异常、循环上限、超时。

前端：
- 在 Chat 页面展示「工具调用卡片」（工具名、参数、结果）。

### 阶段 3：Agent Router（feat: add agent router）

目标：支持 `@researcher` 和 `@coder`。

后端：
- `apps/api/src/agents/AgentRegistry.ts`：注册 `researcher`（资料搜索）和 `coder`（代码分析）两个 Agent，每个 Agent 有自己的 system prompt 和可用工具子集。
- `apps/api/src/agents/Router.ts`：
  - 显式 `@mention` 解析；
  - 无 mention 时按任务类型自动选择（关键词分类）；
  - 未知 Agent 返回错误。
- `apps/api/src/routes/chat.ts`：支持 `{ agent?: string }`。
- 测试：显式路由、自动路由、未知 Agent 错误。

前端：
- 增加 Agent 选择下拉框，支持 `@` 快捷输入。

### 阶段 4：Agent Handoff（feat: add agent handoff）

目标：Agent 之间可以交接任务。

后端：
- `apps/api/src/agents/HandoffManager.ts`：
  - 数据结构：`HandoffRequest`（fromAgent、toAgent、task、context、expectedOutput）；
  - 限制最大 handoff 次数（默认 5）；
  - 记录 handoff 路径，检测循环；
  - 记录失败日志。
- `apps/api/src/agents/AgentLoop.ts`：集成 handoff，支持将任务转交给其他 Agent。
- 测试：正常 handoff、最大次数、循环检测、失败日志。

前端：
- 在对话页面展示 handoff 链路（步骤条）。

### 阶段 5：SQLite 持久化（feat: persist task runs）

目标：持久化 users、threads、messages、tasks、agent_runs、tool_calls。

后端：
- `apps/api/src/db/`：
  - `connection.ts`：创建 `better-sqlite3` 连接；
  - `migrations/`：初始 schema（编号 001）。
- 表结构：users、threads、messages、tasks、agent_runs、tool_calls。
- Task 状态：`pending`、`running`、`completed`、`failed`、`cancelled`。
- 更新 `AgentLoop`/`routes` 写入历史记录。
- 测试：DB 读写、状态流转、迁移幂等。

### 阶段 6：任务队列（feat: add task queue）

目标：`POST /tasks` 创建异步任务，后台执行。

后端：
- `apps/api/src/queue/TaskQueue.ts`：内存队列（后续可替换 Redis）。
- `apps/api/src/queue/QueueWorker.ts`：消费任务，支持并发限制、取消、timeout、重试、幂等。
- `apps/api/src/queue/TaskStatusStore.ts`：查询任务状态。
- `apps/api/src/routes/tasks.ts`：
  - `POST /tasks`：创建任务，立即返回 taskId；
  - `GET /tasks/:id`：查询状态；
  - `POST /tasks/:id/cancel`：取消任务。
- 测试：创建任务、并发限制、超时、重试、幂等、取消。

### 阶段 7：WebSocket 流式事件（feat: add websocket events）

目标：前端实时接收运行事件。

后端：
- `@fastify/websocket` 注册 `/ws` 路由。
- 定义事件协议：
  - `task.started`
  - `tool.started`
  - `tool.completed`
  - `message.delta`
  - `task.completed`
- 任务执行器在关键节点广播事件。
- 测试：WebSocket 事件顺序、断线重连（客户端处理）。

前端：
- `apps/web/src/hooks/useWebSocket.ts`：WebSocket 连接 + 断线重连。
- 聊天页面流式展示文本增量、工具状态、任务完成状态。

### 阶段 8：Trace 与 Evaluation（feat: add agent evaluation）

目标：记录运行轨迹并评估。

后端：
- `apps/api/src/trace/TraceStore.ts`：记录 `runId / taskId / agentId / model / startTime / endTime / toolCalls / status / error`。
- `apps/api/src/eval/EvaluationRunner.ts`：
  - 20 条固定测试任务；
  - 检查：任务完成、正确工具、参数合法、是否超时、是否错误 handoff。
- 评估报告输出为 JSON 或控制台表格。
- 测试：评估自身运行正确。

### 阶段 9：Docker 与部署（feat: add docker deployment）

目标：容器化运行。

- 后端 `Dockerfile`（多阶段构建）。
- 前端 `Dockerfile`（Nginx 静态托管）。
- 根目录 `docker-compose.yml`（API + web + SQLite volume）。
- `.env.example` 模板。
- 简单部署说明。

## 四、Git 提交节奏

按阶段提交，commit message 如下：

```text
feat: add basic agent loop
feat: add tool registry
feat: add agent router
feat: add agent handoff
feat: persist task runs
feat: add task queue
feat: add websocket events
feat: add agent evaluation
feat: add docker deployment
```

## 五、环境依赖

需要用户准备好：
- Node.js 20+
- pnpm
- 一个可用的 OpenAI-compatible API key（`OPENAI_API_KEY`）

## 六、执行顺序

从阶段 1 开始逐阶段实现，每个阶段包含：
1. 后端代码
2. 测试用例
3. 最简前端页面
4. 验证运行
5. Git 提交

请确认此计划后，我将开始实施阶段 1。