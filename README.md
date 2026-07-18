# one-agent

One Agent 是一个**模型无关、可靠性优先的轻量 Agent Runtime**，支持可控工具执行、
长任务规划与恢复、跨会话记忆，以及完整可信的 Trace / Eval 验证闭环。

运行时只负责执行并记录事实：Agent 执行结束后直接向用户返回，不在主链路追加自动验证、
自动分析、自动修复或自动优化任务。开发者通过 Trace Viewer 与离线 Eval 检查过程并决定如何改进 Agent。

项目的长期目标、产品边界、架构设计和当前实现状态统一维护在
[《One Agent：目标、愿景与设计现状》](./docs/project-vision-and-status.md)。

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

Trace Viewer 会按 Thread 和 Run 展示执行时间线。选中单次 Run 后，顶部总览会汇总状态、Trace 健康度、
耗时、token、模型调用、工具调用、重试次数和事件数量；中断前后的 Run 可以沿恢复关系互相跳转。

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
pnpm --filter cli eval -- --real --concurrency 4 # 任务级并发（默认 4；遇到限流可调低）
pnpm --filter cli eval -- --trace            # 持久化 trace，失败可在 trace-web 查看
pnpm --filter cli eval -- --dataset <dir>    # 加载外部 JSON 数据集
pnpm eval:recovery                           # 真实子进程崩溃与断点恢复评测
```

## 内置工具

- `read_file` / `write_file` / `append_file` / `delete_file`：workspace 内文件读写
- `list_files` / `search_files`：目录列举、文件名通配 + 内容搜索
- `run_command`：执行 shell 命令（cwd 限定 workspace，超时 + 输出截断 + 危险命令拦截）
- `web_search`：网络搜索（DuckDuckGo 或 Tavily）
- `get_time`：当前时间
- `spawn_agent`：拉起隔离上下文的子 Agent 执行自包含子任务（深度受限，不可再嵌套）

API 部署时可用 `DISABLED_TOOLS=run_command,delete_file` 禁用高风险工具。

## Trace 与离线 Eval

每次持久化运行都会记录有序 Trace，包括：

- run 的开始、完成、失败或取消，以及实际 loop 模式
- 主模型、自动规划分类、Planner、Judge 和上下文摘要的模型调用、耗时、重试与 token 用量
- plan step 的状态变化、重试和失败分析
- tool call / result 的关联 ID、步骤 ID、状态与耗时
- 流式 reasoning / message（落库时聚合，避免逐 token 写放大）

每个 run 还会保存 `traceStatus`、`droppedTraceEvents` 和 `traceError`。Trace 写入失败不会改变任务执行结果，
但会明确暴露记录不完整，避免把残缺 Trace 当作完整事实。默认 `TRACE_CONTENT=redacted` 会保留分析所需结构并清理凭据；
也可配置为 `metadata` 或 `full`。

Completion Contract 只在 `EvalRunner` 中离线执行，用数据集 checkpoint 检查工具证据与 workspace 终态。
它不会进入 CLI/API 的正常执行路径，也不会在 Agent 回复前增加一次同步验证。

## CLI 命令

- 输入消息并按回车：与 Agent 对话（回复后显示输入/输出 token 用量）
- `/history`：查看当前会话历史
- `/context`：查看当前上下文（含 token 估算、预算、是否已触发摘要）
- `/reasoning`：查看当前运行的推理链
- `/threads`：列出所有会话
- `/runs`：列出当前会话的运行记录
- `/traces`：查看最近运行的 trace 事件
- `/resume <run-id>`：恢复异常中断的 PlanningLoop Run
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

## 断点恢复 v1

PlanningLoop 会把最新计划、步骤状态、重试次数和执行中的工具保存到
`agent_runs.checkpoint`。如果进程在任务中途退出，CLI 下次进入对应会话时会显示可恢复 Run：

```text
Detected 1 interrupted planning run(s).
  /resume ab12cd34
```

执行 `/resume <run-id>` 后会创建一个新 Run，从第一个未完成步骤继续。已经完成的步骤不会重放；
`read_file`、`list_files`、`search_files`、`web_search` 和 `get_time` 可以安全重试。
写入、追加、删除、命令执行等副作用工具如果中断状态不确定，会标记为 `recovery_required`，
不会自动重复执行。每个任务最多自动恢复三次。

`pnpm eval:recovery` 会启动真实 Node 子进程，在步骤模型调用、只读工具执行和写入工具完成后
注入 `SIGKILL`，再启动新进程执行恢复。评测会检查 Run 状态、恢复来源、Trace 连续性、
孤立 tool-call 修复以及副作用工具是否被重复执行。

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
