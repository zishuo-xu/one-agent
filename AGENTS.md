# One Agent 协作开发指南

本文件适用于整个仓库，目标是让新接手的 Agent 在不破坏现有架构边界的前提下快速开始工作。
详细架构、请求链路和常见改动方法见
[Agent 项目接手指南](./docs/agent-maintainer-guide.md)。

## 开始工作前

1. 先运行 `git status --short`。仓库可能包含用户尚未提交的改动，不要覆盖、回退或格式化无关文件。
2. 阅读与任务直接相关的当前文档：
   - 产品与架构：[项目目标、愿景与设计现状](./docs/project-vision-and-status.md)
   - 配置：[配置清单](./docs/configuration-reference.md)
   - 子 Agent：[Sub-Agent Evidence Contract](./docs/sub-agent-evidence-contract.md)
   - 记忆：[Memory Document 设计](./docs/memory-document-design.md)
3. 使用 `rg` / `rg --files` 定位实现和测试，先确定功能属于共享 Runtime 还是某个交互层。
4. 只做任务要求的改动；先跑聚焦测试，再按风险执行包级或全仓验证。

## 不可破坏的架构原则

- **Web、CLI 和 API 共用一套底层。** Agent 行为、规划、子 Agent、预算、工具、记忆、审批和
  Trace 的规则应实现于 `packages/agent-core`。`apps/*` 只负责参数解析、传输和展示，不能复制一套
  Agent 逻辑。
- **`AgentRuntime` 是工作区级装配入口。** 新入口应通过它获得数据库、Store、工具、记忆和
  `AgentLoop`，不要在交互层重新手工拼装依赖。
- **主 Agent 对结果负责。** 用户沟通、最终综合结论和副作用操作由主 Agent 完成。子 Agent 是
  一次性的只读证据收集者，不可递归委派，也不直接生成最终用户回答。
- **计划步骤是工作包，不等于 Agent 数量。** 新计划使用 version 2 的
  `executor`、`checklist`、`scope`、`nonGoals`、`expectedOutcome`、
  `expectedEvidence`、`delegationReason`、`dependsOn`。`DelegationPolicy` 是规划委派和
  动态 `spawn_agent` 的共同准入规则。
- **旧恢复点必须继续可读。** 没有 `version` 的旧 Plan 保持旧叶子步骤语义；新增字段应考虑
  SQLite 旧库、持久化 Trace 和中断恢复兼容。
- **安全策略属于执行层。** 工具审批由 `ToolPolicy` 决定，不能依赖 Prompt、CLI 按钮或 Web
  文案。计划确认与单次危险工具审批是两套独立机制。
- **工作区不写入 Thread 表。** Web 在新建会话时选择工作区，并为该工作区创建/复用
  `AgentRuntime` 和相对 SQLite 数据库。已有会话不能切换工作区。
- **Markdown 是长期记忆事实源。** 全局记忆位于 `~/.one-agent/GLOBAL_MEMORY.md`，工作区记忆
  位于 `<workspace>/.one-agent/MEMORY.md`。SQLite 中的历史 memory 表不是当前事实源。
- **Trace 记录事实，不改变任务结果。** 普通 Trace 写入失败可以降级，但恢复点等关键事实写入失败
  时不能假装继续成功。所有可展示内容都要经过 Trace 内容策略和凭据清理。
- **配置只有一个 Schema。** 新增或修改配置时必须同时更新
  `packages/agent-core/src/config.ts`、`docs/configuration-reference.md`、
  `one-agent.config.example.json` 及对应测试。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `packages/agent-core` | 在线 Runtime、Loop、模型、规划、子 Agent、工具、数据库、记忆、Trace、恢复 |
| `packages/agent-eval` | 离线 Eval、数据集加载、Completion Contract，不进入在线回答主链路 |
| `apps/cli` | CLI 启动、REPL、命令与终端呈现 |
| `apps/api` | Fastify 路由、异步任务、Web 工作区 Runtime 注册 |
| `apps/web` | 本地聊天与设置 UI；消费 API/Trace，不实现 Agent 决策 |
| `apps/trace-web` | 独立 Trace Viewer；运行记录只读，Memory 面板可编辑记忆文档 |
| `docs` | 当前规范与维护指南 |
| `eval-results` | 少量不可由单元测试替代的不可变评测记录及原始证据 |

## 关键入口

| 关注点 | 首先阅读 |
| --- | --- |
| Runtime 装配 | `packages/agent-core/src/runtime/AgentRuntime.ts` |
| 一轮 Agent 执行 | `packages/agent-core/src/agents/AgentLoop.ts` |
| Simple / Planning | `packages/agent-core/src/agents/loops/` |
| 规划与委派规则 | `packages/agent-core/src/planning/Planner.ts`、`DelegationPolicy.ts` |
| 子 Agent 执行 | `packages/agent-core/src/agents/SubAgentRunner.ts`、`spawnAgentTool.ts` |
| 模型与预算 | `packages/agent-core/src/model/`、`config.ts` |
| 工具注册与安全 | `packages/agent-core/src/tools/` |
| SQLite 与 Store | `packages/agent-core/src/db/` |
| 记忆 | `packages/agent-core/src/memory/` |
| Web/API 请求 | `apps/api/src/server.ts`、`routes/web.ts`、`routes/chat.ts` |
| Web 页面 | `apps/web/src/app.js`、`styles.css` |
| CLI 启动 | `apps/cli/src/index.ts`、`chat.ts` |

## 常见改动应放在哪一层

| 需求 | 应修改 | 不应修改 |
| --- | --- | --- |
| 改 Agent 判断或执行行为 | `packages/agent-core` | 只在 Web/CLI 特判 |
| 增加内置工具 | core 的工具工厂、注册表和测试 | 在 UI 直接执行命令 |
| 增加配置 | core Schema/访问器、示例、配置文档、设置 API/UI | 各入口各自维护默认值 |
| 改 Web 布局或交互 | `apps/web`，必要时补 API 展示字段 | 改 Agent 语义来适配页面 |
| 增加 REST 能力 | `apps/api`，业务规则仍下沉 core | 在路由复制 Store/Loop 规则 |
| 改数据库结构 | core migration、Store、恢复兼容测试 | 假设用户总是使用新数据库 |
| 改 Trace 字段 | core 事件类型、记录/清理、API/UI、测试 | 在前端推断不存在的状态 |
| 增加模型协议 | core `ModelProvider` 实现、factory、能力和诊断 | 在 CLI/Web 直接调用模型 SDK |

## 开发与验证

```bash
pnpm install
pnpm build
pnpm test

pnpm dev:cli
pnpm dev:api
pnpm dev:web
pnpm dev:trace-web
```

按改动范围优先使用过滤命令：

```bash
pnpm --filter @one-agent/agent-core test
pnpm --filter @one-agent/agent-core build
pnpm --filter @one-agent/cli test
pnpm --filter @one-agent/api test
pnpm --filter @one-agent/web test
pnpm --filter @one-agent/trace-web test
pnpm --filter @one-agent/agent-eval test
```

仓库没有统一 lint 脚本。至少执行与改动相邻的测试、对应包 build，以及
`git diff --check`。跨 core/API/Web 的功能应再运行 `pnpm test` 和 `pnpm build`。

## 编码与数据注意事项

- TypeScript 使用 ESM；源码相对导入保留 `.js` 后缀。
- 新内置工具必须明确 `readOnly`。只有整批工具都明确只读时，执行层才允许并行。
- 不提交真实 `one-agent.config.json`、API Key、SQLite 数据库、生成的 `dist` 或用户 workspace 内容。
- 数据库迁移应可重复执行，并覆盖旧库升级路径；不要删除兼容字段来“整理”Schema。
- Web 长任务使用异步接口和状态轮询/SSE，不能让 HTTP 请求同步等待完整 Agent Run。
- 自动滚动只应在用户仍位于底部时发生；用户向上查看历史后，新事件不得抢走滚动位置。
- UI 状态必须来自持久化 Run/Trace/恢复点，不能只依赖当前页面内存。
- 错误、超时、取消、预算耗尽和等待输入是不同状态，展示和恢复逻辑不得混为一类。

## 完成标准

交付前确认：

1. 行为实现位于正确层，并同时适用于应共享的 Web/CLI/API。
2. 正常、失败、取消、等待输入/审批及旧数据兼容路径已按风险验证。
3. 新配置、新 Trace 事件或新持久化字段有测试和文档。
4. 没有覆盖用户原有改动，没有提交密钥、数据库或构建产物。
5. 当前事实写入现状文档；阶段过程、修复流水账和一次性审查通过 Git 历史追溯，不新增长期文档。
6. 交接说明包含改了什么、影响哪一层、跑了哪些验证、仍有哪些已知限制。
