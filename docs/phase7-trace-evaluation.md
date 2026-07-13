# Phase 7：Trace 与 Evaluation

**日期**：2026-07-13  
**项目**：one-agent  
**状态**：✅ 已实现

---

## 一、核心目标

让 Agent 运行过程**可回放、可量化**：

- **Trace**：把每次运行的完整事件流（plan / thought / tool_call / tool_result / message_delta 等）持久化到 SQLite，像「行车记录仪」一样可回放。
- **Evaluation**：用确定性模拟场景对 Agent 进行回归测试，自动判断任务是否完成、工具是否正确、参数是否有效、规划是否合理。

---

## 二、技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| Trace 粒度 | 事件级 `trace_events` 表 | 可回放完整轨迹，排查问题时定位到哪一步出错 |
| Trace 数据格式 | `event_type` + `event_data` JSON | `AgentLoopEvent` 是 union，JSON 最灵活 |
| Trace 插入点 | 复用 `AgentLoop.emitEvent` | 单一收口，覆盖同步 `/api/chat` 和异步任务队列两条路径 |
| 任务与运行关联 | `task_id` 写入 `agent_runs` 和 `trace_events` | 支持跨 task / run 查询 |
| Evaluation | 确定性模拟场景 | 结果稳定、可 CI，避免真实模型开销和不稳定性 |

---

## 三、Trace 数据模型

### `trace_events` 表

```text
id TEXT PRIMARY KEY
run_id TEXT
task_id TEXT
thread_id TEXT
event_type TEXT NOT NULL
event_data TEXT NOT NULL
model TEXT
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
```

索引覆盖 `run_id`、`task_id`、`thread_id`。

### `agent_runs` 扩展

新增 `task_id TEXT`（nullable），把运行与任务关联起来。

---

## 四、新增模块

```text
packages/agent-core/src/
├── db/
│   ├── traceEventStore.ts    # TraceEventStore
│   └── types.ts              # TraceEvent / CreateTraceEventInput
├── eval/
│   ├── types.ts              # EvalTask / EvalResult / EvalRunSummary
│   ├── assertions.ts         # 断言 helper
│   ├── runner.ts             # EvalRunner
│   ├── fixtures.ts           # 模拟模型响应 helper
│   └── scenarios/            # 内置评估场景
│       ├── simple-qa.ts
│       ├── read-file.ts
│       ├── list-then-read.ts
│       ├── write-file.ts
│       ├── invalid-arg-retry.ts
│       └── planning.ts
```

---

## 五、Trace 插入流程

1. 任务创建时生成 `taskId`（TaskQueue）。
2. `QueueWorker` 创建 `AgentLoop` 时传入 `taskId`。
3. `AgentLoop.chat()` 创建 `agent_runs` 记录，同时把 `taskId` 写入运行。
4. 运行中的每个事件都经过 `emitEvent()`，写入 `trace_events` 表。
5. 同步 `/api/chat` 路径没有 `taskId`，只记录 `runId` 和 `threadId`。

---

## 六、Evaluation 流程

`EvalRunner` 对一组 `EvalTask` 逐个执行：

1. 创建临时 workspace，写入初始文件。
2. 创建 `ToolRegistry` + `AgentLoop`。
3. 监听 `event` 收集完整事件流。
4. 调用 `agent.chat(prompt)`。
5. 用断言检查：
   - 是否调用了期望工具
   - 工具参数是否匹配
   - 是否调用了禁用工具
   - 最终回答是否包含期望短语
6. 输出 `EvalRunSummary`：total / passed / failed + 每个任务的详细结果。

内置场景：

| 场景 | 说明 |
|------|------|
| `simple-qa` | 直接回答，无需工具 |
| `read-file` | 读取文件并总结 |
| `list-then-read` | 先列目录再读取 |
| `write-file` | 写入文件 |
| `invalid-arg-retry` | 错误参数后重试成功 |
| `planning` | 启用规划，验证 plan 事件 |
| `project-onboarding` | 探索项目结构并说明用途 |
| `create-todo` | 根据用户要求创建待办文件 |
| `find-and-summarize` | 查看并总结代码文件 |
| `multi-step-query` | 多步文件查询 |
| `refusal` | 拒绝危险或不当请求 |
| `empty-workspace-query` | 空 workspace 查询应答 |
| `file-not-found-recovery` | 文件缺失后通过列目录恢复 |
| `summarize-long-file` | 长文本摘要 |
| `multi-tool-planning` | 规划模式下多工具协调 |

### 真实模型适配

为兼顾确定性回归测试和真实模型评测，设计了两种工具断言：

- `expectedTools`：严格按顺序匹配，用于 mock 回归。
- `requiredTools`：只要被调用过即可，更宽容，适合真实模型。
- `finalAnswerContains`：支持多关键词（满足任意一个即可通过），例如 `['Paris', '巴黎']`。
- `expectedFiles`：任务运行后检查 workspace 中文件是否存在，并可校验文件内容。

`EvalRunner` 支持每个任务配置 `timeoutMs`，默认 60 秒，防止真实模型 planning 场景耗时过长。

---

## 七、API 与 CLI

### Trace 查询路由

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/runs/:id/traces` | 按 runId 查询事件流 |
| GET | `/api/tasks/:id/traces` | 按 taskId 查询事件流 |
| GET | `/api/threads/:id/traces` | 按 threadId 查询事件流 |

路由会先校验父资源（run / task / thread）存在性，不存在返回 404，存在则返回 `TraceEvent[]`。

### CLI 命令

```bash
# 查看当前 thread 的全部 trace
> /traces

# 查看指定 run 的 trace
> /traces <run-id>
```

输出格式：

```text
2026-07-13T10:00:00.000Z [plan] {"plan":{"steps":[...]}}
2026-07-13T10:00:01.000Z [tool_call] {"toolCall":{"name":"list_files",...}}
2026-07-13T10:00:02.000Z [message] {"content":"..."}
```

### Trace Web 可视化

新增独立应用 `apps/trace-web`，不侵入 CLI 与 API，方便以后单独取舍。

启动方式：

```bash
# 默认读取 ~/.one-agent/data.db，在 3001 启动 web 服务
pnpm dev:trace-web

# 指定工作目录
pnpm --filter trace-web dev -- --workspace ~/workspace/my-agent

# 指定端口/主机
pnpm --filter trace-web dev -- --port 8080 --host 0.0.0.0
```

浏览器访问后，页面左侧为 thread 列表，中间为 run 列表，右侧为 trace 时间线。支持：

- 按 thread 查看全部 trace
- 按 run 查看单条运行轨迹
- 自动刷新 thread 列表
- 不同事件类型（plan / thought / tool_call / tool_result / message 等）用颜色区分

### 评估脚本

```bash
# 运行确定性评估测试（mock 模型）
pnpm eval

# 用真实模型手动跑评估（CLI 入口）
pnpm --filter cli eval
```

CLI 评估会打印每个任务的 PASS / FAIL 和失败原因。

---

## 八、测试覆盖

```text
packages/agent-core/tests/
├── db/traceEventStore.test.ts
├── agent-loop-trace.test.ts
└── eval/scenarios.test.ts

apps/api/tests/
└── trace-routes.test.ts

apps/trace-web/tests/
└── server.test.ts
```

---

## 九、手动测试用例

### Trace 回放

```bash
pnpm dev:api

# 创建任务并运行
curl -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"message": "帮我列出当前目录的 txt 文件"}'

# 从返回中获取 taskId / runId，查询 trace 事件流
curl http://localhost:3000/api/tasks/<task-id>/traces
curl http://localhost:3000/api/runs/<run-id>/traces
```

### Web 回放

```bash
# 1. 启动 trace-web（默认端口 3001）
pnpm dev:trace-web

# 2. 在另一个终端先产生一次对话（CLI 或 API 均可）
pnpm dev:cli
> 帮我列出当前目录的 txt 文件

# 3. 浏览器访问 http://127.0.0.1:3001
# 在页面左侧选择 thread，中间选择 run，右侧查看事件时间线
```

### CLI 回放

```bash
one-agent

# 先运行一次对话
> 帮我列出当前目录的 txt 文件

# 查看当前 thread 的全部 trace
> /traces

# 或查看某次 run 的 trace
> /runs
> /traces <run-id>
```

### 评估

```bash
# 确定性回归测试（mock 模型）
pnpm eval

# 真实模型评估
pnpm --filter cli eval
```

真实模型评测结果示例：

```text
Total: 10 | Passed: 10 | Failed: 0

[PASS] simple-qa - 4981ms
[PASS] read-file - 14738ms
[PASS] list-then-read - 15260ms
[PASS] write-file - 5425ms
[PASS] invalid-arg-retry - 9087ms
[PASS] planning - 33701ms
[PASS] project-onboarding - 16256ms
[PASS] create-todo - 7580ms
[PASS] find-and-summarize - 7391ms
[PASS] multi-step-query - 8911ms
```


---

## 十、相关文档

- `docs/optimization-notes.md`
- `docs/phase6-async-streaming.md`
- `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`

---

## 十一、下一步

Phase 8：全局 CLI 命令。
