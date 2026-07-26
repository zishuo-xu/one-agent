# Sub-Agent Evidence Contract

> 文档状态：当前设计
> 最后更新：2026-07-26

## 目标

Sub-Agent 是主 Agent 的一次性只读执行单元，不是独立会话或第二个决策中心。Evidence Contract 解决的是：
父 Agent 不应只收到一段无法追溯的自然语言摘要，而应同时知道结论依据了哪些工具观察、证据来自哪里、
以及当前有哪些明确缺口。

## 输入契约

`SubAgentTaskContract` 包含：

- `contractVersion`：值为 `2` 时使用当前工作包准入规则；缺省表示旧委派契约；
- `task`：自包含的子任务；
- `context`：它服务的父级目标；
- `constraints`：不能静默放宽的约束；
- `expectedOutcome`：成功结果的形态；
- `expectedEvidence`：期望采集的证据；
- `scope`：明确包含的调查边界；
- `nonGoals`：明确排除的区域，避免与兄弟工作包重叠；
- `checklist`：由同一个子 Agent 内部完成的检查项，不展开为更多 Agent；
- `delegationReason`：为什么独立委派有价值；
- `allowedTools`：只能收窄 Runtime 已判定为只读的工具集合。

`stepId` 和 `memoryText` 属于 Runtime 执行关联信息，不是模型可以扩大权限的契约字段。

## 输出契约

`SubAgentEvidencePacket` 包含：

- `conclusion`：子 Agent 的自然语言结论；
- `evidence[]`：成功工具观察，每项关联 `toolCallId`、`toolName`、可选 path/URL 和截断后的观察值；
- `uncertainty[]`：工具失败、没有独立观察或证据截断等已知限制；
- `unresolvedQuestions[]`：完全没有成功工具观察时仍未满足的期望证据。

`executionStatus=completed` 只表示隔离循环正常结束，`outcomeStatus=unverified` 表示父 Agent 仍需判断结论是否足以支持父任务。

## 生成方式

Runtime 不额外调用模型整理 Packet。最终回答直接成为 `conclusion`；其余字段由子 Agent 已记录的
`tool_call/tool_result` 事件确定性生成。成功结果进入证据，失败结果进入不确定性，最多保留 8 条观察，
单条观察最多 1200 字符。

这种设计避免增加一次模型延迟和成本，也避免让模型自行伪造证据来源。代价是当前只能建立“工具调用—观察”关系，
不能自动建立“自然语言 claim—观察”关系。

## 上下文与权限

主 Agent 把本轮已加载的全局/工作空间 Memory Document 快照交给 Sub-Agent。子 Agent 不继承
`manage_memory`，不能通过记忆接口修改文档；当前 workspace Sandbox 没有专门屏蔽
`.one-agent/MEMORY.md`，继承 `read_file` 时仍可直接读取该工作区文件。全局记忆位于 workspace 外，
不能通过文件工具访问。每个新父 Run 会清除上一个 Run 的注入快照，并确保没有活动子任务跨越 Run 边界；
当前不存在父 Run 累计委派预算。SimpleLoop 的临时 `spawn_agent` 与 PlanningLoop 的计划委派复用同一
`SubAgentRunner`、只读工具规则和 Evidence Contract。

当主模型在 SimpleLoop 的同一次响应中发出多个 `spawn_agent` 调用时，`ToolRunner` 将它们视为普通的只读工具批次
并发执行，不引入复数工具或第二套委派协议；`subAgent.maxConcurrency` 仍是实际并发上限。父上下文中的
工具结果和持久化 Trace 按原始调用顺序提交，实时 `sub_agent` 事件则保留真实开始、完成时序。

version 2 Planning Plan 的委派单元是完整工作包。`DelegationPolicy` 会把委派节点的 `children`
收敛进该工作包的 `checklist`，由同一个子 Agent 内部完成，而不是为每个叶子创建 Agent。只有无依赖的
只读工作包可以并行；`dependsOn` 会阻止伪并行。缺少 `version` 的历史 Plan 仍按旧叶子步骤语义恢复，
保持旧 Checkpoint 可读。

## Trace

父 Run 的 `sub_agent` 完成事件保存 Evidence Packet 和压缩后的子事件流。Evidence observation 与普通 Trace 内容一样
接受敏感信息脱敏；`trace.contentMode=metadata` 时只保留长度占位，不保存原始观察文本。

## 非目标

- 不自动验证 Sub-Agent 结论正确；
- 不允许 Sub-Agent 写文件、管理记忆、询问用户或继续递归委派；
- 不增加第二次“结果整理”模型调用；
- 不建立共享 Blackboard、持久化子会话或多 Agent 自治网络。
