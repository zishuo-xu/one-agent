# One Agent 统一配置表

> 文档状态：当前有效
> 最后更新：2026-07-26

One Agent 的系统配置默认保存在 `~/.one-agent/one-agent.config.json`，可供不同工作目录共享。工作区根目录可选放置 `one-agent.config.json` 作为该项目的完整配置，并优先于全局配置。模型密钥保存在所选配置文件中，不再读取 `.env` 或业务环境变量。仓库只提交不含真实密钥的 `one-agent.config.example.json`，真实配置已加入 `.gitignore`，CLI 创建文件时使用仅当前用户可读写的权限。

## 1. 读取流程

```text
<workspace>/one-agent.config.json（若存在）
        ↓ 否则
~/.one-agent/one-agent.config.json
        ↓
config.ts：读取 JSON、补全默认值、严格校验
        ↓
SystemConfig：当前进程唯一配置表
        ↓
AgentRuntime：向模型、上下文、工具、Trace、Sub-Agent 等组件装配配置
```

除操作系统运行环境外，业务组件不再直接读取 `process.env`。未知字段、错误类型和非法范围会在启动时报告；不会静默忽略拼写错误。相对数据库路径以 workspace 为基准解析。

workspace 只负责工具执行、项目记忆和相对数据库路径，其选择顺序为：

1. `--workspace <path>`；
2. 从当前目录向上查找最近的 `one-agent.config.json` 或 `.one-agent/MEMORY.md`；
3. 当前目录。

配置选择顺序与 workspace 相互独立：

1. `<workspace>/one-agent.config.json`（项目级完整配置，若存在）；
2. `~/.one-agent/one-agent.config.json`（默认的全局共享配置）。

`one-agent web` 是例外：它始终读取全局配置，启动目录和 Web 中选择的工作目录都不会切换模型配置。
这样 Web 服务可以从任意目录以同样方式启动。普通 CLI `one-agent` 仍保留项目配置优先规则。

首次运行执行 `one-agent --init` 会创建全局配置。只有显式执行
`one-agent --init --workspace <path>` 时，才会创建项目级配置。

CLI 的 `--loop`、`--thread`、`--new`、`--verbose` 只覆盖本次进程，不写回 JSON。
独立运行 `apps/trace-web` 时可以用 `--host`、`--port` 覆盖本次进程；当前 `one-agent trace`
不转发这两个参数，而是固定监听 `127.0.0.1`，从 `3001` 起查找空闲端口。

## 2. 配置结构

完整可复制示例见 [`one-agent.config.example.json`](../one-agent.config.example.json)。顶层 `version`
当前固定为 `1`，省略时由 Schema 补全；其余配置分组也均可省略并使用 Schema 默认值。

### 2.1 `model`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `connectionId` | 不设置 | Web 模型连接表中当前主连接的 ID |
| `provider` | `openai-compatible` | `openai-compatible`、别名 `openai`，或 `anthropic` |
| `baseUrl` | 对应 SDK 默认地址 | 模型 Endpoint |
| `apiKey` | 空 | 主模型密钥；保存在本地真实配置中 |
| `model` | `gpt-3.5-turbo` | 主模型名称 |
| `maxTokens` | `4096` | Anthropic 输出上限 |
| `timeoutMs` | `30000` | 单次模型请求超时 |
| `planningModel` | 主模型 | Planner 与 Task Judge 的模型名称 |
| `utilityModel` | 主模型 | 摘要与记忆整理的模型名称 |
| `fallback` | 不启用 | 可选备用模型对象，字段为 `connectionId/provider/baseUrl/apiKey/model/maxTokens` |

主备协议可以不同。备用模型只在 `fallback` 对象存在时启用；示例文件默认不启用，避免占位密钥被误用。

### 2.1.1 `modelConnections`

Web“设置 → 模型服务”使用这个全局连接表。每个连接包含：

| 字段 | 说明 |
|---|---|
| `id` | 连接的稳定标识，只允许小写字母、数字、`-` 和 `_` |
| `name` | Web 和 CLI 展示名称 |
| `provider` | `openai-compatible`、`openai` 或 `anthropic` |
| `baseUrl` | 可选 Endpoint |
| `apiKey` | 本地保存的密钥；设置 API 只返回 `[REDACTED]` |
| `models` | 此连接可以选择的模型名称数组 |
| `maxTokens` | Anthropic 输出上限 |

旧配置不需要迁移：连接表为空时会从现有 `model` 和 `model.fallback` 自动生成展示项。
保存 Web 设置后，连接表与当前 `model` 主备快照会同时写回全局配置，CLI 与 Web 共用。

### 2.2 `runtime` 与 `context`

| 字段 | 默认值 | 所属层 | 说明 |
|---|---:|---|---|
| `runtime.systemPrompt` | 内置提示词 | Runtime 装配层 | 主 Agent 系统提示词 |
| `runtime.locale` | `zh-CN` | Runtime 装配层 | 用户可见内容的语言；可选 `zh-CN`、`en-US`、`auto` |
| `runtime.customInstructions` | 空字符串 | Runtime 装配层 | 跨主 Agent、规划、任务判断、摘要与子 Agent 生效的用户偏好 |
| `runtime.loop` | `auto` | 执行策略层 | 默认 Loop；CLI `--loop` 可临时覆盖 |
| `runtime.maxRetries` | `2` | 模型调用层 | 模型调用重试次数 |
| `runtime.maxToolIterations` | `5` | AgentLoop | 工具迭代上限 |
| `runtime.maxReplanAttempts` | `3` | PlanningLoop | 重新规划上限 |
| `runtime.maxRetryAttempts` | `2` | PlanningLoop | 步骤重试上限 |
| `runtime.planApproval` | `true` | PlanningLoop | 交互式规划任务执行前是否要求用户确认计划 |
| `context.maxTokens` | `4096` | 上下文层 | 上下文压缩预算 |
| `context.recentTokenBudget` | `2048` | 上下文层 | 近期未摘要消息预算 |

### 2.3 `budget` 与 `subAgent`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `budget.mainAgentTokens` | `null` | 单个主 Agent 的累计模型 token 上限；`null` 表示不限制 |
| `budget.subAgentTokens` | `null` | 单个子 Agent 的累计模型 token 上限；`null` 表示不限制 |

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `subAgent.enabled` | `true` | 是否装配只读委派能力 |
| `subAgent.maxDepth` | `1` | 委派深度保护 |
| `subAgent.maxConcurrency` | `4` | 内部并发保护 |
| `subAgent.taskTimeoutMs` | `60000` | 单个子任务超时 |
| `subAgent.maxToolIterations` | `5` | 单个子 Agent 的工具迭代上限 |

两个预算彼此独立：子 Agent 的用量不会消耗主 Agent 预算，每个子 Agent 也分别计算自己的额度。
达到预算后将停止该 Agent 的后续模型调用。模型服务通常在一次请求完成后才返回权威用量，
因此最后一次已经发出的请求可能略微超过阈值。旧的 `subAgent.maxTasksPerRun` 和
`subAgent.maxTotalTokens` 在加载时会被兼容移除，不再参与运行调度。

运行中策略升级由 `strategy.maxInitialToolBatch`（默认 `2`）和 `strategy.maxSwitches`（默认 `1`）控制，只允许在工具执行前安全地从 SimpleLoop 升级。

`runtime.planApproval` 只控制规划层的整份计划确认：用户可批准、拒绝，或提交一次修改意见后再次确认。
它不会替代 `tools.requireApproval` 对每个高风险工具调用的执行层审批。`runtime.loop=simple` 时没有计划可确认；
非交互式 TaskQueue 会跳过计划确认，避免后台任务永久等待。

`runtime.locale` 和 `runtime.customInstructions` 会统一传递给主回答、规划描述、任务判断、上下文摘要与子 Agent。
结构化 JSON 的字段名、工具名、代码标识符和路径不会被翻译。`customInstructions` 不能覆盖安全策略、工具审批或结构化输出协议。

### 2.4 `tools`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `disabled` | `[]` | 禁用工具名数组，例如 `["run_command", "delete_file"]` |
| `requireApproval` | `["delete_file", "run_command"]` | 每次执行前必须由用户明确批准的工具名数组；设为 `[]` 可关闭交互审批 |
| `search.apiUrl` | 无 | Tavily、Brave 或通用搜索服务地址；未配置时使用 DuckDuckGo |
| `search.apiKey` | 无 | 搜索服务密钥 |

文件 API 和常见直接 shell 命令不能读取或改写 `one-agent.config.json` 与旧 `.env`。但 `run_command` 的静态护栏不是操作系统级安全沙箱；当配置与工具 workspace 位于同一目录时，应只在可信的本地环境启用它，API/共享部署应把 `run_command` 加入 `tools.disabled`。

`disabled` 与 `requireApproval` 的语义不同：前者不注册工具，模型无法调用；后者保留工具能力，但交互式 Runtime 会在副作用发生前持久化冻结参数并等待用户批准。风险判断仍由执行层的 `ToolPolicy` 完成，配置层只提供名单。非交互式 TaskQueue 和子 Agent 不启用交互审批。

### 2.5 `trace`、`storage` 与服务入口

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `trace.contentMode` | `redacted` | `redacted`、`metadata` 或 `full`；生产环境不建议 `full` |
| `trace.host` | `127.0.0.1` | 直接启动 `apps/trace-web` 时的默认地址 |
| `trace.port` | `3001` | 直接启动 `apps/trace-web` 时的默认端口 |
| `trace.logLevel` | `info` | Viewer 日志级别 |
| `storage.databasePath` | `data.db` | SQLite 路径；相对路径基于 workspace |
| `api.host` | `127.0.0.1` | REST API 地址 |
| `api.port` | `3000` | REST API 端口 |
| `api.logLevel` | `info` | API 日志级别 |
| `taskQueue.maxConcurrency` | `2` | API 异步任务并发数 |
| `taskQueue.taskTimeoutMs` | `300000` | 单任务超时 |
| `taskQueue.maxRetries` | `3` | 最大重试次数 |
| `taskQueue.retryDelayMs` | `1000` | 重试间隔 |
| `cli.color` | `true` | 是否输出 ANSI 颜色 |

Web 多工作区要求 `storage.databasePath` 为相对路径，使每个工作目录自然拥有独立数据库。
若配置为绝对路径，当前目录仍可运行，但 Web 会拒绝切换到其他工作区，避免不同项目混用 Thread。

## 3. 创建与迁移

首次使用：

```bash
one-agent --init
# 编辑 ~/.one-agent/one-agent.config.json 中的
# model.apiKey、model.model 和可选 model.baseUrl
```

若某个项目确实需要独立配置：

```bash
one-agent --init --workspace /path/to/project
```

如果当前 workspace 中存在旧 `.env`，`--init` 会一次性导入已识别的旧配置和密钥到目标 JSON，且不删除旧文件；之后 One Agent 不再读取 `.env`。确认 JSON 工作正常后，开发人员可自行移除旧文件。

## 4. 配置治理规则

1. 新增可调参数必须加入 `SystemConfig` Schema、示例 JSON和本清单；
2. 默认值只在 Schema 中定义，组件不重复维护另一套业务默认值；
3. 每项配置归属一个明确领域，组件只使用自己需要的配置分组；
4. 真实配置和密钥不进入 Git、Trace、日志或 Agent 文件工具；
5. 配置不会由 Agent 自动优化或改写；Web 设置保存和 CLI `/model` 等显式用户操作可以原子写回 JSON，
   Web 会在没有运行中或等待审批任务时重建工作区 Runtime，使新配置从后续任务生效；
6. Eval 命令参数属于离线评测输入，不混入 Runtime 配置表。
