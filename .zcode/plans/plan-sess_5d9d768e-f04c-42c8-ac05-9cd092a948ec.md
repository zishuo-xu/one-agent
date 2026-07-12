# Phase 4 实施计划：规划与自我纠错

基于更新后的路线图，本阶段让 Agent 从「被动调用工具」升级为「先规划再执行，失败能自纠」的 ReAct 式单 Agent。

## 一、目标

```text
复杂任务 -> 拆解为计划 -> 逐步执行 -> 观察结果 -> 偏差则反思重试
```

- 显式规划：模型先输出可执行计划
- ReAct 推理链：Thought -> Action -> Observation 显式化
- 自我纠错：工具失败或结果不符时，反思并换方案
- 任务完成判定：明确判断目标是否达成，而非仅看是否不再调工具

## 二、设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 规划模式 | 默认启用 | 用户选择，让 CLI 每个任务都先出计划 |
| 规划触发 | 所有非简单对话 | 简单对话会被计划为「单步：直接回答」 |
| 计划结构 | 步骤数组（PlanStep） | 清晰、可追踪、可评估 |
| 推理链 | 内置在 AgentLoop 中 | 保持单 Agent 架构简洁 |
| 失败处理 | 记录失败，模型反思后重新规划 | 不自动无限重试，设最大反思次数 |

## 三、新增模块

### 1. `packages/agent-core/src/planning/types.ts`

类型定义：

```ts
interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

interface Plan {
  steps: PlanStep[];
  reasoning: string;
}

interface ReasoningStep {
  thought?: string;
  action?: ToolCall;
  observation?: ToolResult;
  reflection?: string;
}

interface JudgeResult {
  complete: boolean;
  reasoning: string;
  nextAction: 'continue' | 'replan' | 'retry' | 'finalize';
}
```

### 2. `packages/agent-core/src/planning/Planner.ts`

职责：根据用户意图和可用工具生成初始计划。

- 输入：用户消息、可用工具 schema
- 输出：`Plan` 对象
- 实现：通过模型调用 + system prompt 要求输出 JSON 计划
- 失败回退：若解析失败，返回单步计划「直接回答用户」

### 3. `packages/agent-core/src/planning/ReasoningChain.ts`

职责：记录 ReAct 推理链。

- `addThought(thought: string)`
- `addAction(action: ToolCall)`
- `addObservation(observation: ToolResult)`
- `addReflection(reflection: string)`
- `toMessages()`：将推理链转为 `Message[]` 供模型消费

### 4. `packages/agent-core/src/planning/TaskJudge.ts`

职责：判断任务是否完成或需要重新规划。

- 输入：当前计划、最近一条/多条推理步骤、工具结果
- 输出：`JudgeResult`
- 实现：模型调用，prompt 要求评估当前状态并给出结论

## 四、修改 AgentLoop

### 4.1 扩展事件类型

在 `AgentLoopEvent` 中新增：

```ts
type AgentLoopEvent =
  | { type: 'plan'; plan: Plan }
  | { type: 'thought'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'reflection'; content: string }
  | { type: 'message'; content: string };
```

### 4.2 重构内部循环

`AgentLoop.chat()` 改为三阶段循环：

```text
1. Planning 阶段
   - 调用 Planner 生成 Plan
   - 发送 plan 事件

2. Execution 阶段（每步循环）
   - 模型产生 Thought + Action
   - 发送 thought 事件
   - 执行工具，得到 Observation
   - 发送 tool_call / tool_result 事件
   - 记录 ReasoningStep

3. Judging 阶段
   - 调用 TaskJudge 判断是否完成
   - 如果 complete：请求模型生成最终回答
   - 如果 replan：回到 Planning 阶段，更新计划
   - 如果 retry：重试上一步
   - 如果 continue：执行下一步
```

### 4.3 保持向后兼容

- `AgentLoopOptions` 默认启用 planning
- 提供 `enablePlanning?: boolean` 选项，关闭后行为与 Phase 2 相同

## 五、CLI 更新

`apps/cli/src/index.ts` 的 `printEvent` 函数扩展：

```text
[计划]
1. 读取 notes.txt
2. 写入 summary.md

[思考] 我需要先了解 notes.txt 的内容
[调用工具] read_file: {"path":"notes.txt"}
[工具结果] {"success":true,...}
[思考] 已经读取，接下来写入 summary.md
[调用工具] write_file: {...}
[工具结果] {"success":true,...}
[反思] 所有步骤已完成，可以生成最终回答

Agent: 已完成！已创建 summary.md
```

新增 `/reasoning` 命令显示当前推理链。

## 六、API 更新（可选但建议）

`apps/api/src/routes/chat.ts` 更新为：

- 创建 `ContextManager` 和 `ToolRegistry`
- 传给 `AgentLoop`
- 返回的 `events` 包含 planning 事件，客户端可流式展示

本次先做基础接入，流式留到 Phase 6。

## 七、测试计划

新增 `packages/agent-core/tests/planning/`：

1. `planner.test.ts`：Planner 生成计划、解析失败回退
2. `reasoning-chain.test.ts`：记录 thought/action/observation
3. `task-judge.test.ts`：完成/重试/重新规划判断
4. `planning-agent-loop.test.ts`：完整 planning 循环，含成功路径和失败自纠路径

## 八、文件变更清单

```text
新增：
  packages/agent-core/src/planning/types.ts
  packages/agent-core/src/planning/Planner.ts
  packages/agent-core/src/planning/ReasoningChain.ts
  packages/agent-core/src/planning/TaskJudge.ts
  packages/agent-core/tests/planning/planner.test.ts
  packages/agent-core/tests/planning/reasoning-chain.test.ts
  packages/agent-core/tests/planning/task-judge.test.ts
  packages/agent-core/tests/planning/planning-agent-loop.test.ts

修改：
  packages/agent-core/src/agents/AgentLoop.ts
  packages/agent-core/src/agents/types.ts
  packages/agent-core/src/index.ts
  apps/cli/src/index.ts
  apps/api/src/routes/chat.ts
```

## 九、Git 提交

```text
feat: add planning and self-correction loop
```

## 十、验证标准

- `pnpm build` 通过
- `pnpm test` 全部通过
- CLI 实测：
  - 复杂任务能生成计划
  - 工具失败时模型能反思并换方案
  - 简单任务也能直接回答

---

请确认此方案后，我开始实现 Phase 4。