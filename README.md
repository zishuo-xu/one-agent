# one-agent

简化版单 Agent 运行时（CLI 优先），专注吃透一个 Agent 的完整内核。

## 项目结构

```text
one-agent/
├── apps/
│   ├── api/     # Fastify + TypeScript 后端（可选 REST API）
│   └── cli/     # 交互式 REPL CLI
└── packages/
    ├── agent-core/  # Agent 核心：AgentLoop、配置、模型调用
    └── shared/      # 共享类型和常量
```

## 环境准备

```bash
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY
```

## 快速开始

### 启动 CLI REPL

```bash
pnpm install
pnpm dev:cli
```

### 启动 REST API（可选）

```bash
pnpm dev:api
```

### 测试

```bash
pnpm test
```

## CLI 命令

- 输入消息并按回车：与 Agent 对话
- `/history`：查看当前会话历史
- `/exit` 或 `/quit`：退出

## 阶段

见 [SIMPLIFIED_AGENT_PROJECT_ROADMAP.md](./SIMPLIFIED_AGENT_PROJECT_ROADMAP.md)。

## 当前阶段

- [x] Phase 1：单 Agent（CLI + API）
- [x] Phase 2：Tool Calling
- [ ] Phase 3：上下文与记忆管理
- [ ] Phase 4：规划与自我纠错
- [ ] Phase 5：SQLite 持久化
- [ ] Phase 6：异步任务与流式输出
- [ ] Phase 7：Trace 与 Evaluation
- [ ] Phase 8：Docker 与部署
