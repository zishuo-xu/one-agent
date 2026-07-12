# one-agent

简化版多 Agent 协作平台。

## 项目结构

```text
one-agent/
├── apps/
│   ├── api/     # Fastify + TypeScript 后端
│   └── web/     # Vite + React 前端
└── packages/
    └── shared/  # 共享类型和常量
```

## 环境准备

```bash
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY
```

## 快速开始

```bash
pnpm install
pnpm dev        # 同时启动后端和前端
pnpm test       # 运行后端测试
```

## 阶段

见 [SIMPLIFIED_AGENT_PROJECT_ROADMAP.md](./SIMPLIFIED_AGENT_PROJECT_ROADMAP.md)。

## 当前阶段

- [x] Phase 1：单 Agent（`POST /api/chat`）
- [ ] Phase 2：Tool Calling
- [ ] Phase 3：Agent Router
- [ ] Phase 4：Agent Handoff
- [ ] Phase 5：SQLite 持久化
- [ ] Phase 6：任务队列
- [ ] Phase 7：WebSocket
- [ ] Phase 8：Trace 与 Evaluation
- [ ] Phase 9：Docker 与部署
