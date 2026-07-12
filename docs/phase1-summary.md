# One Agent 项目 — 第一阶段总结报告

**生成日期**：2026-07-13  
**技术栈**：TypeScript + pnpm workspace + Fastify + OpenAI-compatible SDK

---

## 一、项目背景

One Agent 是一个简化版多 Agent 协作平台，目标是理解并复现 `clowder-ai` 的核心思想：

```text
用户输入 → API → Router → Agent → Tool → 持久化 → WebSocket
```

项目采用 **pnpm workspace** 管理的多包仓库结构，便于将 Agent 核心、REST API 和 CLI 等不同入口解耦。

---

## 二、阶段 1 目标

实现单 Agent 的最小闭环：

```text
用户输入 → 调用模型 → 返回回答
```

主要学习点包括：API 调用、message history、system prompt、环境变量、错误处理和基础测试。

---

## 三、实现内容

### 3.1 项目骨架

- **pnpm workspace monorepo**：`apps/api`、`apps/cli`、`packages/agent-core`、`packages/shared`
- **TypeScript 5.x** + **tsx** 开发热重载 + **vitest** 测试框架
- **dotenv** 统一加载根目录 `.env`，支持 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` 等配置

### 3.2 packages/agent-core

Agent 核心逻辑被抽取为独立包，供 API 和 CLI 共享，避免重复代码。包含：

- `config.ts`：集中读取环境变量，初始化 OpenAI-compatible 客户端
- `AgentLoop.ts`：封装模型调用，维护 `system/user/assistant` 消息历史，支持重试与超时
- 测试覆盖：正常返回、自定义 system prompt、失败重试、空内容处理

### 3.3 apps/cli 交互式 REPL

按照需求将前端从 Web 改为 CLI，提供交互式 REPL 入口：

- 启动后进入对话循环，实时调用模型返回回答
- 内置 `/history` 查看当前会话历史
- 内置 `/exit` 或 `/quit` 优雅退出
- 通过 `load-env.ts` 在 ESM import 提升前加载 `.env`，确保配置正确读取

### 3.4 apps/api 可选 REST API

保留 Fastify 后端作为可选接口：

- `POST /api/chat`：接收 `message`，返回模型回答
- `GET /api/health`：健康检查，返回当前模型名称

---

## 四、项目结构

```text
one-agent/
├── apps/
│   ├── api/          # Fastify REST API
│   └── cli/          # 交互式 CLI REPL
├── packages/
│   ├── agent-core/   # AgentLoop、config、模型调用
│   └── shared/       # 共享类型与常量
├── .env              # 模型配置（已 gitignore）
├── .env.example
└── README.md
```

---

## 五、亮点

| 亮点 | 说明 |
|------|------|
| **CLI 优先** | 将交互入口从 Web 改为 CLI REPL，更适合后续工具调用场景。 |
| **核心复用** | `packages/agent-core` 让 API 和 CLI 共用同一套 `AgentLoop` 与配置。 |
| **工程规范** | pnpm workspace + TypeScript 项目引用 + 单元/集成测试。 |
| **配置安全** | `.env` 文件加载在 `agent-core` 之前，避免 ESM 提升导致配置失效。 |
| **测试覆盖** | 7 个测试用例全部通过，覆盖 AgentLoop、配置、API 路由。 |

---

## 六、验证结果

执行 `pnpm build` 与 `pnpm test`：

```text
✓ pnpm build：agent-core / api / cli 全部编译通过
✓ pnpm test：7 个测试全部通过
```

CLI 实测结果：

```text
🤖 One Agent CLI
Model: glm-5.2

You: 你好
Agent: 你好！请问有什么我可以帮你的？
```

---

## 七、Git 提交记录

```text
66dad41 feat: add basic agent loop
f3bba47 chore: ignore generated files and plan metadata
8c36ee4 docs: add README and env example
74fc2a2 refactor: extract agent-core and add CLI REPL
edde385 fix: load .env before agent-core config in CLI/API
```

---

## 八、后续计划

接下来将进入 **第二阶段 Tool Calling**，实现：

- `ToolRegistry`：注册工具 schema（zod）
- `ToolExecutor`：执行 `get_weather` 和 `search_knowledge` 工具
- `AgentLoop` 升级：支持 tool call / tool result 多轮循环，限制最大循环次数和超时
- CLI 展示：在 REPL 中打印工具调用过程与结果
