# One Agent 配置清单

> 文档状态：当前有效
> 最后更新：2026-07-19

本清单是 One Agent 配置项的唯一索引。它统一说明配置名、默认值、所属层、来源和覆盖方式，但**不是新的全局配置中心**：模型层、Runtime、执行层和各入口仍只读取自己拥有的配置，避免一个配置对象跨层传播。

## 1. 配置来源与优先级

CLI 与 Trace Viewer 按以下顺序选择 workspace：

1. `--workspace <path>`；
2. `ONE_AGENT_WORKSPACE`；
3. 当前目录（仅当目录内存在 `.env`）；
4. `~/.one-agent`。

选定 workspace 后读取其中的 `.env`。进程启动前已经设置的环境变量优先于 `.env`。CLI、Trace Viewer 默认使用 `<workspace>/data.db`；API 在仓库开发模式下读取根目录 `.env`，workspace 固定为仓库的 `workspace/`。

`.env.example` 是可复制的常用模板，本文件是包含兼容项和代码级参数的完整清单。密钥只应放在本地 `.env` 或进程环境中，不进入 Git、Trace 或文档。

## 2. 环境变量

### 2.1 主模型与用途模型（模型层）

| 配置 | 默认值 | 必填条件 | 说明 |
|---|---:|---|---|
| `MODEL_PROVIDER` | `openai-compatible` | 否 | `openai-compatible`、别名 `openai`，或 `anthropic` |
| `OPENAI_BASE_URL` | OpenAI SDK 默认地址 | OpenAI Compatible 网关按需 | 主模型 Endpoint |
| `OPENAI_API_KEY` | 空 | OpenAI Compatible 必填；Anthropic 可作后备凭据 | 主模型密钥 |
| `OPENAI_MODEL` | `gpt-3.5-turbo` | 否 | OpenAI Compatible 主模型 |
| `ANTHROPIC_BASE_URL` | Anthropic SDK 默认地址 | Anthropic 网关按需 | 原生 Anthropic Messages Endpoint |
| `ANTHROPIC_API_KEY` | 复用 `OPENAI_API_KEY` | 两者均未配置时必填 | Anthropic 主模型密钥 |
| `ANTHROPIC_MODEL` | 无 | `MODEL_PROVIDER=anthropic` 时必填 | Anthropic 主模型 |
| `ANTHROPIC_MAX_TOKENS` | `4096` | 否 | Anthropic 单次输出上限，必须为正整数 |
| `MODEL_TIMEOUT_MS` | `30000` | 否 | 所有主模型协议的单次请求超时 |
| `PLANNING_MODEL` | 主模型 | 否 | Planner 与 Task Judge 使用的模型名；协议和凭据沿用主模型 |
| `UTILITY_MODEL` | 主模型 | 否 | 摘要与记忆整理使用的模型名；协议和凭据沿用主模型 |

### 2.2 备用模型（模型层）

仅设置 `FALLBACK_MODEL_PROVIDER` 才启用正式的协议无关备用链；旧版 `OPENAI_FALLBACK_BASE_URL` 也会为兼容目的启用 OpenAI Compatible 备用模型。

| 配置 | 默认值 | 说明 |
|---|---:|---|
| `FALLBACK_MODEL_PROVIDER` | 无（不启用） | `openai-compatible` / `openai` / `anthropic` |
| `FALLBACK_BASE_URL` | 对应 SDK 默认地址 | 备用 Endpoint |
| `FALLBACK_API_KEY` | 按协议回退到旧变量或主模型 Key | 备用密钥 |
| `FALLBACK_MODEL` | `OPENAI_FALLBACK_MODEL`，再回退主模型 | 备用模型名 |
| `FALLBACK_MAX_TOKENS` | `4096` | Anthropic 备用模型输出上限 |

以下变量只为旧配置兼容，新配置不要继续使用：

| 兼容变量 | 正式替代项 |
|---|---|
| `OPENAI_TIMEOUT_MS` | `MODEL_TIMEOUT_MS` |
| `OPENAI_FALLBACK_BASE_URL` | `FALLBACK_BASE_URL` |
| `OPENAI_FALLBACK_API_KEY` | `FALLBACK_API_KEY` |
| `OPENAI_FALLBACK_MODEL` | `FALLBACK_MODEL` |
| `ANTHROPIC_FALLBACK_BASE_URL` | `FALLBACK_BASE_URL` |
| `ANTHROPIC_FALLBACK_API_KEY` | `FALLBACK_API_KEY` |
| `ANTHROPIC_FALLBACK_MAX_TOKENS` | `FALLBACK_MAX_TOKENS` |

### 2.3 Runtime、上下文与工具

| 配置 | 默认值 | 所属层 | 说明 |
|---|---:|---|---|
| `SYSTEM_PROMPT` | 内置中文助手提示词 | Runtime 装配层 | 主 Agent 系统提示词 |
| `MAX_CONTEXT_TOKENS` | `4096` | 上下文层 | 超过预算时触发上下文压缩 |
| `RECENT_TOKEN_BUDGET` | `2048` | 上下文层 | 保留近期未摘要消息的 token 预算 |
| `DISABLED_TOOLS` | 空 | 工具装配层 | 逗号分隔的禁用工具名 |
| `SEARCH_API_URL` | 无 | 工具层 | 搜索服务地址；未配置时使用 DuckDuckGo |
| `SEARCH_API_KEY` | 无 | 工具层 | 搜索服务密钥 |

### 2.4 持久化、Trace 与服务入口

| 配置 | 默认值 | 所属层 | 说明 |
|---|---:|---|---|
| `ONE_AGENT_WORKSPACE` | 见 workspace 优先级 | CLI / Trace 入口层 | 默认 workspace；`--workspace` 优先 |
| `DATABASE_PATH` | CLI/Trace 为 `<workspace>/data.db`；core 直用为 `workspace/data.db` | 持久化层 | SQLite 文件路径；测试可用 `:memory:` |
| `TRACE_CONTENT` | `redacted` | Trace 层 | `redacted`、`metadata` 或 `full`；生产环境不建议 `full` |
| `PORT` | `3000` | API 入口层 | REST API 监听端口 |
| `HOST` | `127.0.0.1` | API 入口层 | REST API 监听地址 |
| `LOG_LEVEL` | `info` | API / Trace 入口层 | Fastify 日志级别 |
| `TASK_MAX_RETRIES` | `3` | API 任务队列层 | 异步任务最大重试次数 |
| `TASK_RETRY_DELAY_MS` | `1000` | API 任务队列层 | 异步任务重试间隔 |
| `NO_COLOR` | 未设置 | CLI 展示层 | 设置任意非空值即关闭 ANSI 颜色 |

Trace Viewer 的监听地址不读取 `PORT` / `HOST`，而由 `one-agent trace --port <port> --host <host>` 控制，默认 `127.0.0.1:3001`。这样 API 与只读 Viewer 可以同时启动且不会争用端口。

## 3. 代码级 Runtime 参数

这些参数服务于嵌入、测试和特定入口，不是 `.env` 配置。它们由对应组件拥有，只有调用方显式构造组件时才覆盖默认值。

### 3.1 `AgentRuntime.createAgent(...)`（装配层）

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `planning` | 入口决定；CLI 为 `auto` | 选择 `simple`、`planning` 或自动路由 |
| `subAgents` | `true` | 是否装配只读 `spawn_agent` 工具 |
| `subAgentBudget` | 见下表 | 覆盖当前父 Run 的委派预算 |
| `userInput` | `true` | 是否装配持久化询问能力；非交互 worker 可关闭 |
| `threadId` / `taskId` | 无 | 关联持久化会话和异步任务 |
| `signal` | 无 | 取消当前执行 |

### 3.2 `AgentLoop`（执行层）

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `maxRetries` | `2` | 模型调用失败后的重试次数 |
| `timeoutMs` | `MODEL_TIMEOUT_MS` | 单次模型请求超时 |
| `maxToolIterations` | `5` | 一次 Loop 的工具迭代上限 |
| `maxReplanAttempts` | `3` | PlanningLoop 重新规划上限 |
| `maxRetryAttempts` | `2` | PlanningLoop 步骤重试上限 |
| `maxSubAgentDepth` | `1` | 委派深度上限；子 Agent 不再递归委派 |

依赖注入参数（Provider、Store、Planner、Judge、ContextManager、ToolPolicy、StrategyController 等）用于替换组件，不属于面向用户的调优旋钮。

### 3.3 Sub-Agent 委派预算（执行层）

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `maxTasksPerRun` | `8` | 一个父 Run 最多接受的子任务数 |
| `maxConcurrency` | `4` | 同一父 Run 的子任务并发上限 |
| `maxTotalTokens` | `50000` | 达到已观测累计 token 后拒绝新委派 |
| `taskTimeoutMs` | `60000` | 单个子任务执行超时 |
| `maxToolIterations` | `5` | 单个子 Agent 的工具迭代上限 |

### 3.4 策略控制与异步任务（各自执行层）

| 组件参数 | 默认值 | 作用 |
|---|---:|---|
| `StrategyController.maxInitialToolBatch` | `2` | SimpleLoop 首批工具超过该数量时可升级 PlanningLoop |
| `StrategyController.maxSwitches` | `1` | 单 Run 的策略升级次数上限 |
| `TaskQueue.maxConcurrency` | core 默认 `1`；API 固定 `2` | 异步任务并发数 |
| `TaskQueue.taskTimeoutMs` | `300000` | 单个异步任务超时 |
| `TaskQueue.maxRetries` | `3` | core 默认重试次数；API 可由环境变量覆盖 |
| `TaskQueue.retryDelayMs` | `1000` | core 默认重试间隔；API 可由环境变量覆盖 |

## 4. CLI 启动参数

这些参数只影响本次进程，不写回 `.env`：

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `--workspace <path>` | workspace 解析规则 | 指定 workspace |
| `--loop auto\|simple\|planning` | `auto` | 选择运行策略 |
| `--new` | 否 | 创建新 Thread |
| `--thread <id>` | 最近 Thread | 进入指定 Thread |
| `--verbose` | 否 | 分区显示 reasoning 与内部规划信息 |
| `--init` | 否 | 在 workspace 创建最小 `.env` 模板 |
| `trace --port <port>` | `3001` | Trace Viewer 端口 |
| `trace --host <host>` | `127.0.0.1` | Trace Viewer 地址 |

`--plan`、`--plan-auto` 和 `--trace` 是兼容参数，不应出现在新脚本中。

## 5. 配置治理规则

1. 新增环境变量时，同一提交更新本清单；属于常用配置时同时更新 `.env.example`；
2. 新增代码级调优参数时，必须有明确的所属组件和默认值，不把配置跨多个层读取；
3. 环境变量使用协议无关命名；旧名称只做有限兼容并在本清单标记；
4. 默认值以代码为最终依据，文档修改必须通过配置相关测试与构建；
5. Eval 数据集、并发和超时属于评测命令参数，不混入 Runtime 配置；
6. 配置清单只治理输入，不负责运行时自动优化或动态改写配置。
