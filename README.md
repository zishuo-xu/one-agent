# one-agent

简化版单 Agent 运行时（CLI 优先），专注吃透一个 Agent 的完整内核。

## 项目结构

```text
one-agent/
├── apps/
│   ├── api/        # Fastify + TypeScript 后端（可选 REST API）
│   ├── cli/        # 交互式 REPL CLI
│   └── trace-web/  # 运行追踪可视化 Web 界面
└── packages/
    └── agent-core/  # Agent 核心：AgentLoop 门面 + ModelCaller/RunRecorder +
                     #   loops（simple/planning 双策略）、规划、工具、上下文、
                     #   记忆、模型抽象、SQLite 持久化（详见 docs/architecture-refactor-2026-07.md）
```

## 环境准备

```bash
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY
```

支持任意 OpenAI 兼容端点（OpenAI / DeepSeek / Qwen / Kimi / GLM / Ollama）。
可选配置备用模型：设置 `OPENAI_FALLBACK_BASE_URL` / `OPENAI_FALLBACK_API_KEY` /
`OPENAI_FALLBACK_MODEL` 后，主模型出现 5xx / 429 / 网络错误时自动 failover。

## 快速开始

### 启动 CLI REPL

```bash
pnpm install
pnpm dev:cli
```

### 同时启动 CLI + Trace Viewer

```bash
pnpm dev          # trace-web 后台运行 + CLI 前台交互
pnpm dev:trace-web  # 单独启动追踪可视化
```

也可以在启动 CLI 时加 `--trace` 自动拉起 trace-web：

```bash
pnpm dev:cli -- --trace
```

### 全局安装（输入 `one-agent` 启动）

```bash
pnpm build
cd apps/cli
pnpm link --global

# 首次运行前准备 API key
mkdir -p ~/.one-agent
cp ../../.env.example ~/.one-agent/.env
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

### 测试与评估

```bash
pnpm test                    # 全套单元测试
pnpm eval                    # eval 场景回归（agent-core vitest）
pnpm --filter cli eval       # CLI eval（mock 模式，20 个内置场景）
pnpm --filter cli eval -- --real             # 真实模型 benchmark
pnpm --filter cli eval -- --trace            # 持久化 trace，失败可在 trace-web 查看
pnpm --filter cli eval -- --dataset <dir>    # 加载外部 JSON 数据集
```

## 内置工具

- `read_file` / `write_file` / `append_file` / `delete_file`：workspace 内文件读写
- `list_files` / `search_files`：目录列举、文件名通配 + 内容搜索
- `run_command`：执行 shell 命令（cwd 限定 workspace，超时 + 输出截断 + 危险命令拦截）
- `web_search`：网络搜索（DuckDuckGo 或 Tavily）
- `get_time`：当前时间
- `spawn_agent`：拉起隔离上下文的子 Agent 执行自包含子任务（深度受限，不可再嵌套）

API 部署时可用 `DISABLED_TOOLS=run_command,delete_file` 禁用高风险工具。

## CLI 命令

- 输入消息并按回车：与 Agent 对话（回复后显示输入/输出 token 用量）
- `/history`：查看当前会话历史
- `/context`：查看当前上下文（含 token 估算、预算、是否已触发摘要）
- `/reasoning`：查看当前运行的推理链
- `/threads`：列出所有会话
- `/runs`：列出当前会话的运行记录
- `/traces`：查看最近运行的 trace 事件
- `/thread <id>`：切换到指定会话
- `/help`：查看可用命令
- `/exit` 或 `/quit`：退出

启动 CLI 时：

```bash
pnpm dev:cli                          # 默认恢复最近会话
pnpm dev:cli -- --new                 # 强制新建会话
pnpm dev:cli -- --thread <id>         # 恢复指定 thread
pnpm dev:cli -- --trace               # 同时启动 trace-web 追踪可视化
pnpm dev:cli -- --plan                # 开启规划模式（多步任务）
pnpm dev:cli -- --plan-auto           # 自动判断：简单问题直接答、复杂问题才规划
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
- [x] Phase 9：任务持久化（SQLite TaskStore + 重启恢复）
- [x] Phase 10：长期记忆检索（跨 thread 记忆共享）
- [x] Phase 11：规划增强（plan-execution 绑定 + 分层计划 + 结构化失败分析）
- [x] Phase 12：多模型抽象层（ModelProvider 接口 + 主备 failover）
- [x] Phase 13：工具生态扩展（run_command + 文件工具补齐）
- [x] Phase 14：Eval+Trace 联动（失败案例可观测闭环 + JSON 数据集）
- [x] Phase 15：子 Agent（spawn_agent 工具 + delegate/parallel 波次并行委派）
- [x] Phase 16：子 Agent 观测性（嵌套 trace 展示内部事件流）+ 子 Agent 模型降级（UTILITY_MODEL）
