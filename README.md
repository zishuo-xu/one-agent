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

### 全局安装（输入 `one-agent` 启动）

```bash
pnpm build
cd apps/cli
pnpm link --global

# 首次运行前准备 API key
mkdir -p ~/.one-agent
cp .env.example ~/.one-agent/.env
# 编辑 ~/.one-agent/.env，填入 OPENAI_API_KEY

# 在非仓库目录任意位置启动
one-agent

# 指定工作目录
one-agent --workspace ~/my-agent
```

注意：如果在仓库根目录运行 `one-agent`，由于当前目录存在 `.env`，会优先使用仓库目录作为 workspace。要体验全局默认行为，请在非仓库目录启动。

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
- `/context`：查看当前压缩后的上下文
- `/reasoning`：查看当前运行的推理链
- `/threads`：列出所有会话
- `/runs`：列出当前会话的运行记录
- `/thread <id>`：切换到指定会话
- `/exit` 或 `/quit`：退出

启动 CLI 时：

```bash
pnpm dev:cli                          # 新建 thread
pnpm dev:cli -- --thread <id>         # 恢复指定 thread
pnpm dev:cli -- --thread <id> --new-thread  # 强制用指定 id 新建 thread
```

## 阶段

见 [SIMPLIFIED_AGENT_PROJECT_ROADMAP.md](./SIMPLIFIED_AGENT_PROJECT_ROADMAP.md)。

## 当前阶段

- [x] Phase 1：单 Agent（CLI + API）
- [x] Phase 2：Tool Calling
- [x] Phase 3：上下文与记忆管理
- [x] Phase 4：规划与自我纠错
- [x] Phase 5：SQLite 持久化
- [x] Phase 6：异步任务与流式输出
- [x] Phase 7：Trace 与 Evaluation
- [x] Phase 8：全局 CLI 命令
