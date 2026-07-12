# One Agent 项目 — 第一阶段架构设计

**版本**：Phase 1  
**日期**：2026-07-13  
**技术栈**：TypeScript + pnpm workspace + Fastify + OpenAI-compatible SDK

---

## 一、设计目标

第一阶段的架构设计目标是实现一个**可复用、可测试、易扩展**的单 Agent 最小闭环：

```text
用户输入 → 调用模型 → 返回回答
```

为了支撑后续阶段（Tool Calling、Agent Router、Handoff、持久化等），架构需要提前把「Agent 核心能力」和「交互入口」解耦。

---

## 二、整体架构

项目采用 **pnpm workspace 单体仓库**，整体分为三层：

```text
┌─────────────────────────────────────────┐
│  交互层（Entry Layer）                    │
│  ├─ apps/cli    交互式 REPL（主要入口）   │
│  └─ apps/api    Fastify REST API（可选）  │
├─────────────────────────────────────────┤
│  核心层（Core Layer）                     │
│  └─ packages/agent-core                 │
│      ├─ config.ts    环境变量 / 模型客户端 │
│      └─ AgentLoop.ts  对话循环 / 历史 / 重试 │
├─────────────────────────────────────────┤
│  共享层（Shared Layer）                   │
│  └─ packages/shared                     │
│      └─ 类型、常量（当前为占位）          │
└─────────────────────────────────────────┘
```

---

## 三、各层职责

### 3.1 核心层：`packages/agent-core`

Agent 核心逻辑被抽取为独立包，供 CLI 和 API 共享，避免重复实现。

| 模块 | 文件 | 职责 |
|------|------|------|
| 配置 | `src/config.ts` | 读取 `.env`，初始化 OpenAI-compatible 客户端，集中管理模型参数 |
| 对话循环 | `src/agents/AgentLoop.ts` | 维护消息历史、调用模型、支持重试与超时、返回回答 |
| 导出 | `src/index.ts` | 统一导出 `config`、`AgentLoop` 及相关类型 |

**设计原则**：
- 不依赖任何 UI 框架或 Web 框架
- 不依赖具体交互入口
- 可独立进行单元测试

### 3.2 CLI 入口：`apps/cli`

基于 `node:readline/promises` 实现的交互式 REPL，是用户与 Agent 的主要交互方式。

| 文件 | 职责 |
|------|------|
| `src/load-env.ts` | 在 ESM import 提升前加载根目录 `.env` |
| `src/index.ts` | REPL 主循环：读取输入 → 调用 AgentLoop → 展示回答 |

**支持的命令**：

| 命令 | 说明 |
|------|------|
| `/history` | 查看当前会话的完整消息历史 |
| `/exit` / `/quit` | 优雅退出 REPL |

### 3.3 API 入口：`apps/api`

基于 Fastify 的 REST API，作为可选入口，方便外部系统调用或后续集成 WebSocket。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 接收 `{ message }`，调用 AgentLoop 返回 `{ reply }` |
| `/api/health` | GET | 健康检查，返回当前模型名称 |

| 文件 | 职责 |
|------|------|
| `src/load-env.ts` | 加载根目录 `.env` |
| `src/server.ts` | 构建 Fastify 实例并注册路由 |
| `src/routes/chat.ts` | 实现 `/api/chat` 和 `/api/health` |
| `src/index.ts` | 启动服务 |

### 3.4 共享层：`packages/shared`

预留的共享包，用于放置跨包使用的类型定义和常量。当前内容较少，随着项目发展会逐步填充。

---

## 四、数据流

一次完整对话的数据流如下：

```text
用户输入（CLI / API）
    │
    ▼
┌─────────────────┐
│  apps/cli       │  ┌─────────────────┐
│  或 apps/api    │  │  输入校验、参数  │
└────────┬────────┘  └─────────────────┘
         │
         ▼
┌─────────────────────────┐
│  @one-agent/agent-core  │
│  ├─ config.ts           │  读取 OPENAI_BASE_URL、KEY、MODEL
│  └─ AgentLoop.chat()    │  维护历史 → 调用模型 → 返回回答
└────────┬────────────────┘
         │
         ▼
    展示给用户
```

`AgentLoop` 内部的消息历史示例：

```text
system: You are a helpful assistant. ...
user:   你好
assistant: 你好！请问有什么我可以帮你的？
user:   帮我查一下北京天气
assistant: ...（后续阶段会加入 tool call）
```

---

## 五、关键设计决策

| 决策 | 说明 | 原因 |
|------|------|------|
| **pnpm workspace** | 多包管理 | 核心、CLI、API 独立演进，依赖清晰 |
| **agent-core 独立成包** | AgentLoop 和 config 放在 `packages/agent-core` | CLI 和 API 共享同一套模型调用逻辑，避免重复 |
| **CLI 优先** | 用 REPL 替代 Web 前端 | 工具调用场景下，命令行比 Web 更自然、更易自动化 |
| **先 load .env 再 import core** | `load-env.ts` 在 `index.ts` 最顶部 import | 解决 ESM import 提升导致 `process.env` 未生效的问题 |
| **OpenAI-compatible SDK** | 使用 `openai` 库，支持任意兼容接口 | 当前配置为 `glm-5.2`（火山方舟），可灵活切换模型 |
| **TypeScript 项目引用** | `tsconfig.json` 配置 `references` | 保证核心先编译，支持类型安全 |

---

## 六、目录结构

```text
one-agent/
├── apps/
│   ├── api/                  # Fastify REST API
│   │   ├── src/
│   │   │   ├── load-env.ts   # 加载 .env
│   │   │   ├── index.ts      # 服务入口
│   │   │   ├── server.ts     # Fastify 实例
│   │   │   └── routes/
│   │   │       └── chat.ts   # /api/chat / /api/health
│   │   ├── tests/
│   │   │   └── chat-routes.test.ts
│   │   └── package.json
│   └── cli/                  # 交互式 REPL
│       ├── src/
│       │   ├── load-env.ts   # 加载 .env
│       │   └── index.ts      # REPL 主循环
│       └── package.json
├── packages/
│   ├── agent-core/           # Agent 核心
│   │   ├── src/
│   │   │   ├── config.ts
│   │   │   ├── agents/
│   │   │   │   └── AgentLoop.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   │   ├── agent-loop.test.ts
│   │   │   └── config.test.ts
│   │   └── package.json
│   └── shared/               # 共享类型与常量
│       ├── src/
│       │   └── index.ts
│       └── package.json
├── .env                      # 模型配置（已 gitignore）
├── .env.example
├── package.json              # root scripts + workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

---

## 七、模块依赖关系

```text
apps/cli
   │
   ├─ imports ──► @one-agent/agent-core
   │                 │
   │                 ├─ openai
   │                 └─ zod（后续使用）
   │
apps/api
   │
   ├─ imports ──► @one-agent/agent-core
   │
   └─ imports ──► fastify
```

`packages/shared` 目前无依赖，后续会承载跨包类型。

---

## 八、与后续阶段的衔接

当前架构已经为后续阶段预留了扩展位：

| 阶段 | 扩展位置 | 说明 |
|------|----------|------|
| Phase 2 Tool Calling | `packages/agent-core` | 增加 `ToolRegistry`、`ToolExecutor`，升级 `AgentLoop` 支持多轮 tool call |
| Phase 3 Agent Router | `packages/agent-core` | 增加 `AgentRegistry`、`Router`，支持 `@mention` 和自动路由 |
| Phase 4 Handoff | `packages/agent-core` | 增加 `HandoffManager`，记录 handoff 链路与循环检测 |
| Phase 5 持久化 | `packages/agent-core` | 通过依赖注入接入 SQLite，CLI 和 API 同时获得持久化能力 |
| Phase 6 任务队列 | `apps/api` | 增加 `TaskQueue`、`QueueWorker`，CLI 可选支持 |
| Phase 7 WebSocket | `apps/api` | 增加 `/ws` 实时事件流，CLI 可订阅或打印日志 |

---

## 九、总结

第一阶段架构的核心是 **「一个可复用的 Agent 核心 + 一个 CLI 主入口 + 一个可选 API 入口」**：

- **Agent 核心**（`packages/agent-core`）负责模型调用、配置和对话历史
- **CLI 入口**（`apps/cli`）是主要交互界面，适合工具调用和自动化
- **API 入口**（`apps/api`）提供 REST 能力，便于集成和后续扩展

这种分层设计让后续阶段可以**只改核心层**，而 CLI 和 API 自动获得新能力，降低了演进成本。
