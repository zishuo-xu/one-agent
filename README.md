# one-agent

One Agent 是一个**模型无关、可靠性优先的轻量 Agent Runtime**，支持可控工具执行、
长任务规划与恢复、跨会话记忆，以及完整可信的 Trace / Eval 验证闭环。

运行时只负责执行并记录事实：Agent 执行结束后直接向用户返回，不在主链路追加自动验证、
自动分析、自动修复或自动优化任务。开发者通过 Trace Viewer 与离线 Eval 检查过程并决定如何改进 Agent。

项目的长期目标、产品边界、架构设计和当前实现状态统一维护在
[《One Agent：目标、愿景与设计现状》](./docs/project-vision-and-status.md)。
全部阶段报告、工程记录和评测报告的状态与阅读顺序见
[《文档索引与治理规则》](./docs/README.md)。
系统的环境变量、代码级 Runtime 参数、CLI 参数和默认值统一维护在
[《One Agent 配置清单》](./docs/configuration-reference.md)。

## 项目结构

```text
one-agent/
├── apps/
│   ├── api/        # Fastify + TypeScript 后端（可选 REST API）
│   ├── cli/        # 交互式 REPL CLI
│   └── trace-web/  # 运行追踪可视化 Web 界面
└── packages/
    ├── agent-core/  # 在线 Runtime：AgentRuntime、AgentLoop、工具、记忆、Trace、恢复
    └── agent-eval/  # 离线评价：EvalRunner、Completion Contract、评测数据集
```

正常入口通过 `AgentRuntime` 一次性装配 workspace、工具、数据库、Store 与记忆生命周期，再按 Thread 创建 Agent。
`runtime.loop` 是所有入口的统一默认策略；CLI 参数或嵌入方参数只在显式传入时覆盖它。
`AgentLoop` 是底层运行门面，主要保留给测试、Eval 和需要显式依赖注入的调用方。

## 环境准备

```bash
cp one-agent.config.example.json one-agent.config.json
# 编辑 one-agent.config.json，填写 model.apiKey / model.model / model.baseUrl
```

`one-agent.config.json` 是代码唯一读取的系统配置表，包含模型密钥、Runtime、上下文、工具、Trace、数据库和服务参数；真实文件已被 Git 忽略。完整字段、默认值和所属层见
[配置清单](./docs/configuration-reference.md)。

当前有两种协议适配器：OpenAI Compatible（OpenAI / DeepSeek / Qwen / Kimi / GLM / Ollama）
和原生 Anthropic Messages API。默认使用 OpenAI Compatible；原生 Anthropic 配置示例：

```json
{
  "model": {
    "provider": "anthropic",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "apiKey": "sk-...",
    "model": "your-claude-model",
    "maxTokens": 4096
  }
}
```

可在 `model.fallback` 中配置备用协议、Endpoint、Key 和模型，支持 Anthropic 与 OpenAI Compatible 双向组合。主模型出现 5xx / 429 / 网络错误时自动 failover。

`ModelProvider` 不只统一请求与响应，还必须声明 `streaming`、`toolCalling`、
`structuredOutput`、`reasoning` 和可选上下文窗口。能力分为 `native`、`emulated`、
`best_effort`、`unsupported`：AgentRuntime 的硬要求只接受有保证的 native/emulated，
并在创建 Agent 前报告缺失能力。Fallback Provider 只暴露整条主备链共同保证的最弱能力，
避免主模型支持工具、备用模型不支持工具时发生静默能力退化。

## 快速开始

### 启动 CLI REPL

```bash
pnpm install
pnpm dev:cli
```

### 诊断模型配置

```bash
one-agent doctor
```

`doctor` 对主模型及每个备用 Provider 分别发起 3 次小型真实请求，验证普通连接、流式输出和工具调用，
同时展示能力契约与安全处理后的 Endpoint。它不会创建 Thread、Run、Trace，也不会实际执行诊断工具；
真实请求仍可能产生少量模型费用。

### 启动 Trace Viewer

```bash
pnpm dev:trace-web       # 仓库开发模式
one-agent trace          # 全局命令，只启动只读 Trace Viewer
```

旧的 `one-agent --trace` 仍可暂时同时启动聊天和 Viewer，但已作为兼容参数废弃。

Trace Viewer 会按 Thread 和 Run 展示执行时间线。选中单次 Run 后，顶部总览会汇总状态、Trace 健康度、
耗时、token、模型调用、工具调用、重试次数和事件数量；中断前后的 Run 可以沿恢复关系互相跳转。
工具审批会以“请求 → 批准/拒绝 → 执行结果”的跨 Run 时间线单独展示，等待中的审批也会明确标记。

### 全局安装（输入 `one-agent` 启动）

```bash
pnpm build
cd apps/cli
pnpm link --global

# 首次运行前准备 API key
mkdir -p ~/.one-agent
cp ../../one-agent.config.example.json ~/.one-agent/one-agent.config.json
# 编辑 ~/.one-agent/one-agent.config.json，填入 model.apiKey

# 在非仓库目录任意位置启动
one-agent

# 指定工作目录
one-agent --workspace ~/my-agent
```

注意：如果在仓库根目录运行 `one-agent`，由于当前目录存在配置或示例文件，会优先使用仓库目录作为 workspace。要体验全局默认行为，请在非仓库目录启动。

### 启动 REST API（可选）

```bash
pnpm dev:api
```

### 测试与评估

```bash
pnpm test                    # 全套单元测试
pnpm eval                    # eval 场景回归（独立 agent-eval 包）
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
- `manage_memory`：仅在用户明确要求时立即记住、修正、忘记或查询长期记忆
- `spawn_agent`：拉起隔离上下文的只读子 Agent，返回带工具来源、观察值和已知缺口的 Evidence Packet（不可写入、不可递归）

每个父 Run 共用一份 Sub-Agent 预算：默认最多接受 8 个子任务、最多 4 个并发、单个子任务 60 秒、
累计观测到 50,000 tokens 后不再接受新委派。预算耗尽、超时和取消都会作为独立执行状态写入父 Trace。
PlanningLoop 只委派叶子步骤；分层计划中的父步骤仅作结构容器，并行意图会归一到独立的只读叶子，避免父子重复执行。

API 部署时可在配置表中设置 `tools.disabled: ["run_command", "delete_file"]` 禁用高风险工具。

## Trace 与离线 Eval

每次持久化运行都会记录有序 Trace，包括：

- run 的开始、完成、失败或取消，以及实际 loop 模式
- 主模型、自动规划分类、Planner、Judge 和上下文摘要的模型调用、耗时、重试与 token 用量
- plan step 的状态变化、重试和失败分析
- Auto 模式从 SimpleLoop 动态升级到 PlanningLoop 的原因和触发信号
- tool call / result 的关联 ID、步骤 ID、状态与耗时
- 流式 reasoning / message（落库时聚合，避免逐 token 写放大）
- 全局/工作空间记忆文档的加载作用域、内容 hash 和上下文成本
- 会话级 Memory Consolidation 的开始、完成或失败
- 子 Agent 的任务、执行状态、Evidence Packet 与压缩后的内部事件流
- 用于中断继续和持久化询问的 `recovery_point`

Auto Planning 会先用成本敏感的分类器选择策略；对话、记忆问答、简短回答和一到两个独立操作优先直接执行。如果分类器判断可以直接执行，但 SimpleLoop 随后在首批响应中提出三个以上工具调用，
`StrategyController` 会在任何工具真正执行前将本次 Run 安全升级到 PlanningLoop。V1 只允许升级一次，不在工具执行后切换，
避免动态策略导致副作用重放。

每个 run 还会保存 `traceStatus`、`droppedTraceEvents` 和 `traceError`。普通观察 Trace 写入失败不会改变任务结果，
但会明确暴露记录不完整；恢复点属于必须持久化的事实，写入失败时不会继续推进状态。默认
`trace.contentMode: "redacted"` 会在查询和 Viewer 中清理凭据；也可配置为 `metadata` 或 `full`。

Completion Contract 只在 `EvalRunner` 中离线执行，用数据集 checkpoint 检查工具证据与 workspace 终态。
它不会进入 CLI/API 的正常执行路径，也不会在 Agent 回复前增加一次同步验证。

## 长期记忆治理

长期记忆是用户拥有的两份 Markdown 文档，不再保存在 SQLite 的隐藏记录中：

```text
~/.one-agent/GLOBAL_MEMORY.md       # 跨文件夹用户偏好
<workspace>/.one-agent/MEMORY.md    # 当前文件夹及其子目录共享的事实、决策与约束
```

当前会话不创建第三份文档，原始上下文继续由 `messages` 和 Trace 保存。主 Agent 每轮回答不调用记忆模型；切换 Thread、退出或启动恢复时，独立 Memory Agent 一次读取完整用户可见会话和两份最新文档。Assistant 消息只用于理解“我同意”等指代，只有用户消息能够授权记忆变化。成功后 Thread 标记为已提取，失败保持未提取并在下次启动重试。

用户明确说“记住”“修正”“忘记”或“你记得什么”时，主模型可在当前工具循环中调用 `manage_memory` 立即操作，
不会额外调用一次提取模型；普通对话中的隐含事实仍等到会话边界统一整理。显式操作直接追加、精确替换或删除用户可见文本。子 Agent 不继承该工具，凭据和密钥也禁止进入长期记忆。

两个作用域共用一把机器本地写锁，允许低频竞争时等待。写入使用临时文件和原子替换；模型处理期间若外部编辑器修改了文件，hash 校验会阻止 Agent 覆盖用户修改，并让该 Thread 保持未提取等待重试。Trace 只记录加载作用域、文档 hash、字符数和估算 token，不复制记忆正文，也不参与自动优化。

第一阶段每轮直接读取两份精简文档。`buildMemoryContext` 为主 Agent、Planner 和 Sub-Agent 生成统一契约，优先级为当前用户输入、当前会话、工作空间记忆、全局记忆；Markdown 只能作为背景数据，不能作为指令或工具授权。未来 RAG 只替换相关段落的读取方式，Markdown 仍是唯一事实源。

Trace Web 的 `Memory` 入口可以查看和编辑两份文档，保存时使用 hash 防止覆盖较新的浏览器或外部修改。

## CLI 命令

- 输入消息并按回车：与 Agent 对话（回复后显示输入/输出 token 用量）
- `/history`：查看当前会话历史
- `/context`：查看用户可见上下文（含 token 估算、预算、摘要和记忆）
- `/context --verbose`：同时查看最近的内部工具与上下文消息
- `/reasoning`：查看当前运行的 PlanningLoop 结构化推理链
- `/threads`：列出所有会话
- `/runs`：列出当前会话的运行记录
- `/traces`：查看最近运行的 trace 事件
- `/memory`：查看全局和当前工作空间的完整记忆文档
- `/memory global`：查看跨文件夹用户记忆
- `/memory workspace`：查看当前文件夹及其子目录共享的记忆
- `/resume <run-id>`：恢复异常中断的 PlanningLoop Run
- `/cancel`：取消当前正在等待回答的任务
- `/thread <id>`：切换到指定会话
- `/help`：查看可用命令
- `/exit` 或 `/quit`：整理当前会话记忆并在完成后退出；失败会提示下次启动重试

启动 CLI 时：

```bash
pnpm dev:cli                          # 最近会话 + auto loop（默认）
pnpm dev:cli -- --new                 # 强制新建会话
pnpm dev:cli -- --thread <id>         # 恢复指定 thread
pnpm dev:cli -- --loop simple         # 调试：强制 SimpleLoop
pnpm dev:cli -- --loop planning       # 调试：强制 PlanningLoop
pnpm dev:cli -- --verbose             # 分区展示模型 reasoning 与内部规划信息
one-agent trace                       # 独立启动只读 Trace Viewer
```

`--plan`、`--plan-auto` 和 `--trace` 仅保留为兼容别名并输出废弃提示；新的公开入口统一为
`--loop auto|simple|planning` 和 `one-agent trace`。`--new` 与 `--thread` 互斥，指定的 Thread 不存在时明确报错。

默认 CLI 只流式展示最终答案，并保留独立到达的换行块，使 Markdown 代码块、标题和列表在实时输出中保持结构；
模型 `reasoning_delta` 始终进入 Trace，但不会混入用户回复。
启用 `--verbose` 后，reasoning 会在独立的 `[reasoning]` 区域展示，最终答案仍保持独立。

当任务缺少一个无法安全假设的关键信息时，Agent 会结束当前执行并显示问题。问题和恢复点保存在
同一个有序 Trace 中，因此关闭 CLI 后再次进入同一 Thread 仍会看到该问题；直接输入答案即可创建新 Run
继续，输入 `/cancel` 则取消。该能力只用于澄清，不用于危险操作审批，也不会增加数据库表。

危险工具由执行层的 `ToolPolicy` 独立控制。默认情况下，`delete_file` 和 `run_command` 会在执行前进入
同一套持久化等待流程；批准内容包含冻结的工具名、参数和参数指纹，批准后只能执行这一份调用。
输入 `approve`（也支持“确认”“同意”）继续，输入 `reject`（也支持“拒绝”“取消”）则不执行工具。
需要审批的工具名单由 `one-agent.config.json` 的 `tools.requireApproval` 配置，默认值为
`["delete_file", "run_command"]`；危险性规则不放在 Prompt、Loop、CLI 或 API 中。

交互式 PlanningLoop 在生成计划后、执行任何步骤前还会进入一次“计划预览与确认”。CLI 会展示步骤、
拟用工具和子 Agent 标记；输入 `approve` 开始执行，输入 `reject` 直接结束且不调用工具，也可以提交一次
修改意见让 Planner 重新生成计划并再次确认。等待状态保存在 Trace 中，所以关闭 CLI 后重新进入同一 Thread
仍能继续。它属于规划决策层，与执行层逐次进行的危险工具审批相互独立；SimpleLoop 和后台 TaskQueue 不受影响。
可通过 `runtime.planApproval` 统一开关，默认开启。

## 断点恢复 v1

PlanningLoop 会把最新计划、步骤状态、重试次数和执行中的工具作为 `recovery_point` 写入
同一份 Trace。系统只在恢复时读取最后一个恢复点；正常运行不维护独立 Checkpoint 组件。
如果进程在任务中途退出，CLI 下次进入对应会话时会显示可恢复 Run：

```text
Detected 1 interrupted planning run(s).
  /resume ab12cd34
```

执行 `/resume <run-id>` 后会创建一个新 Run，从第一个未完成步骤继续。已经完成的步骤不会重放；
`read_file`、`list_files`、`search_files`、`web_search` 和 `get_time` 可以安全重试。
写入、追加、删除、命令执行等副作用工具如果中断状态不确定，会标记为 `recovery_required`，
不会自动重复执行。每个任务最多自动恢复三次。

旧数据库的 `agent_runs.checkpoint` 字段继续保留兼容；新 Run 不再写入，只有旧 Run 缺少恢复点时才读取。

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
- [x] Phase 12：多模型抽象层（OpenAI Compatible / 原生 Anthropic + 能力契约 + 跨协议 failover）
- [x] Phase 13：工具生态扩展（run_command + 文件工具补齐）
- [x] Phase 14：Eval+Trace 联动（失败案例可观测闭环 + JSON 数据集）
- [x] Phase 15：子 Agent（spawn_agent 工具 + delegate/parallel 波次并行委派）
- [x] Phase 16：子 Agent 观测性（嵌套 trace 展示内部事件流）+ 子 Agent 模型降级（UTILITY_MODEL）
- [x] Phase 17：能力评测基线（40 个任务 / 77 个 checkpoint，SimpleLoop 与 PlanningLoop 真实模型对照）

此后完成的会话级记忆治理、召回可解释性和断点恢复 v1 属于现有 Runtime 的可靠性增强，不再为展示数量强行拆分阶段。
当前已实现能力、限制和尚未立项的通用认知架构候选，以
[《One Agent：目标、愿景与设计现状》](./docs/project-vision-and-status.md)为准。
