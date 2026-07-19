# One Agent 统一配置表

> 文档状态：当前有效
> 最后更新：2026-07-19

One Agent 的系统配置统一保存在 workspace 根目录的 `one-agent.config.json`。模型密钥也在该文件中，不再读取 `.env` 或业务环境变量。仓库只提交不含真实密钥的 `one-agent.config.example.json`，真实配置已加入 `.gitignore`，CLI 创建文件时使用仅当前用户可读写的权限。

## 1. 读取流程

```text
one-agent.config.json
        ↓
ConfigLoader：读取 JSON、补全默认值、严格校验
        ↓
SystemConfig：当前进程唯一配置表
        ↓
AgentRuntime：向模型、上下文、工具、Trace、Sub-Agent 等组件装配配置
```

除操作系统运行环境外，业务组件不再直接读取 `process.env`。未知字段、错误类型和非法范围会在启动时报告；不会静默忽略拼写错误。相对数据库路径以 workspace 为基准解析。

workspace 选择顺序为：

1. `--workspace <path>`；
2. 当前目录（存在 `one-agent.config.json` 或仓库示例文件）；
3. `~/.one-agent`。

CLI 的 `--loop`、`--thread`、`--new`、`--verbose` 以及 Trace Viewer 的 `--host`、`--port` 只覆盖本次进程，不写回 JSON。

## 2. 配置结构

完整可复制示例见 [`one-agent.config.example.json`](../one-agent.config.example.json)。所有分组均可省略；省略后由 Schema 补全默认值。

### 2.1 `model`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `provider` | `openai-compatible` | `openai-compatible`、别名 `openai`，或 `anthropic` |
| `baseUrl` | 对应 SDK 默认地址 | 模型 Endpoint |
| `apiKey` | 空 | 主模型密钥；保存在本地真实配置中 |
| `model` | `gpt-3.5-turbo` | 主模型名称 |
| `maxTokens` | `4096` | Anthropic 输出上限 |
| `timeoutMs` | `30000` | 单次模型请求超时 |
| `planningModel` | 主模型 | Planner 与 Task Judge 的模型名称 |
| `utilityModel` | 主模型 | 摘要与记忆整理的模型名称 |
| `fallback` | 不启用 | 可选备用模型对象，字段为 `provider/baseUrl/apiKey/model/maxTokens` |

主备协议可以不同。备用模型只在 `fallback` 对象存在时启用；示例文件默认不启用，避免占位密钥被误用。

### 2.2 `runtime` 与 `context`

| 字段 | 默认值 | 所属层 | 说明 |
|---|---:|---|---|
| `runtime.systemPrompt` | 内置提示词 | Runtime 装配层 | 主 Agent 系统提示词 |
| `runtime.loop` | `auto` | 执行策略层 | 默认 Loop；CLI `--loop` 可临时覆盖 |
| `runtime.maxRetries` | `2` | 模型调用层 | 模型调用重试次数 |
| `runtime.maxToolIterations` | `5` | AgentLoop | 工具迭代上限 |
| `runtime.maxReplanAttempts` | `3` | PlanningLoop | 重新规划上限 |
| `runtime.maxRetryAttempts` | `2` | PlanningLoop | 步骤重试上限 |
| `runtime.planApproval` | `true` | PlanningLoop | 交互式规划任务执行前是否要求用户确认计划 |
| `context.maxTokens` | `4096` | 上下文层 | 上下文压缩预算 |
| `context.recentTokenBudget` | `2048` | 上下文层 | 近期未摘要消息预算 |

### 2.3 `subAgent`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 是否装配只读委派能力 |
| `maxDepth` | `1` | 委派深度上限 |
| `maxTasksPerRun` | `8` | 每个父 Run 最多接受的子任务 |
| `maxConcurrency` | `4` | 子任务并发上限 |
| `maxTotalTokens` | `50000` | 达到累计观测 token 后拒绝新委派 |
| `taskTimeoutMs` | `60000` | 单个子任务超时 |
| `maxToolIterations` | `5` | 单个子 Agent 的工具迭代上限 |

运行中策略升级由 `strategy.maxInitialToolBatch`（默认 `2`）和 `strategy.maxSwitches`（默认 `1`）控制，只允许在工具执行前安全地从 SimpleLoop 升级。

`runtime.planApproval` 只控制规划层的整份计划确认：用户可批准、拒绝，或提交一次修改意见后再次确认。
它不会替代 `tools.requireApproval` 对每个高风险工具调用的执行层审批。`runtime.loop=simple` 时没有计划可确认；
非交互式 TaskQueue 会跳过计划确认，避免后台任务永久等待。

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
| `trace.host` | `127.0.0.1` | Trace Viewer 默认地址 |
| `trace.port` | `3001` | Trace Viewer 默认端口 |
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

## 3. 创建与迁移

首次使用：

```bash
cp one-agent.config.example.json one-agent.config.json
# 编辑 model.apiKey、model.model 和可选 model.baseUrl
```

也可以运行：

```bash
one-agent --init
```

如果 workspace 中存在旧 `.env`，`--init` 会在本地一次性导入已识别的旧配置和密钥，创建 JSON 后不删除旧文件；之后 One Agent 不再读取 `.env`。确认 JSON 工作正常后，开发人员可自行移除旧文件。

## 4. 配置治理规则

1. 新增可调参数必须加入 `SystemConfig` Schema、示例 JSON和本清单；
2. 默认值只在 Schema 中定义，组件不重复维护另一套业务默认值；
3. 每项配置归属一个明确领域，组件只使用自己需要的配置分组；
4. 真实配置和密钥不进入 Git、Trace、日志或 Agent 文件工具；
5. 配置启动时加载一次并视为只读，不在运行中自动优化或改写；
6. Eval 命令参数属于离线评测输入，不混入 Runtime 配置表。
