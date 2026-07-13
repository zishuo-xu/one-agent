# 规划能力深度优化：计划绑定、层级计划、结构化反思、真实模型评估

## 目标

一次性增强 Agent 的规划与评估能力：

1. **计划与执行绑定**：让模型严格按计划步骤调用指定工具，偏差时触发失败处理。
2. **子目标拆解（层级计划）**：支持 plan step 嵌套子步骤，适应复杂任务。
3. **反思质量提升**：Judge 输出结构化失败分析，用于更精准的重规划。
4. **真实模型评估**：在现有 mock 回归之外，支持对真实模型跑 benchmark 并收集指标。

## 实现顺序

按依赖顺序分 4 个阶段实现，每个阶段独立 commit：

### 第一阶段：计划与执行绑定

#### 数据模型改造 `packages/agent-core/src/planning/types.ts`

`PlanStep` 增加可选约束字段：

```ts
export interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  allowedTools?: string[];
  requiredTool?: string;
  strict?: boolean;
  children?: PlanStep[];
  parentId?: string;
}
```

`ReasoningStep` 增加 `planStepId`：

```ts
export interface ReasoningStep {
  thought?: string;
  action?: ToolCall;
  observation?: ToolResult;
  reflection?: string;
  planStepId?: string;
  failureAnalysis?: FailureAnalysis;
}
```

#### 执行绑定 `packages/agent-core/src/agents/AgentLoop.ts`

- `executeStep` 接收当前 `PlanStep`。
- 如果 step 有 `requiredTool` 或 `allowedTools`，调用 `callModel` 时只传入这些工具的 schema（通过 `toolRegistry` 子集）。
- 模型返回 tool calls 后，检查是否使用了允许的工具：
  - 若偏离计划，标记 step 为 `failed`，调用 judge 决定 retry/replan。
  - 记录 `failureAnalysis` 到 `ReasoningStep`。
- 每次 thought/action/observation 都记录 `planStepId`。

#### 推理链 `packages/agent-core/src/planning/ReasoningChain.ts`

- `commitStep(planStepId)` 方法将当前推理步骤绑定到 plan step。
- `getStepsByPlanStep(planStepId)` 方便查询。

### 第二阶段：结构化反思 / 失败分析

#### 数据模型 `packages/agent-core/src/planning/types.ts`

新增 `FailureAnalysis`：

```ts
export interface FailureAnalysis {
  category: 'tool_failure' | 'plan_mismatch' | 'missing_info' | 'wrong_args' | 'other';
  affectedStepIds?: string[];
  rootCause?: string;
  recommendation?: string;
}
```

#### Judge 改造 `packages/agent-core/src/planning/TaskJudge.ts`

- `judgeSchema` 扩展 `failureAnalysis` 字段。
- Prompt 明确要求模型输出失败类别、根因、建议。
- 返回 `JudgeResult` 时包含结构化分析。

#### AgentLoop 重规划 `packages/agent-core/src/agents/AgentLoop.ts`

- `replan` 接收 `failureAnalysis` 而不是简单字符串。
- 将 `affectedStepIds` 和 `recommendation` 传给 `Planner.createPlan`，让新计划更精准。
- 发出更丰富的 `reflection` 事件。

### 第三阶段：层级计划

#### Planner 改造 `packages/agent-core/src/planning/Planner.ts`

- Zod schema 支持 `children` 递归。
- Prompt 要求模型对复杂步骤拆分子步骤。
- `planSchema` 版本保持向后兼容：无 `children` 时仍是平级计划。

#### AgentLoop 执行树 `packages/agent-core/src/agents/AgentLoop.ts`

- 将单索引 `currentStepIndex` 改为深度优先遍历树。
- 使用栈结构：遇到有 `children` 的 step，先执行子步骤，再回父步骤。
- 父步骤状态由子步骤聚合：全部完成则父完成，任一失败则父失败。
- 对每个 step 执行第一阶段绑定的逻辑。

#### 推理链 `packages/agent-core/src/planning/ReasoningChain.ts`

- 支持嵌套 `subSteps`。
- `toMessages()` 递归渲染层级。

### 第四阶段：真实模型评估

#### EvalRunner 模式 `packages/agent-core/src/eval/types.ts` 和 `runner.ts`

- `EvalRunnerOptions` 增加 `mode?: 'mock' | 'real'`。
- `mock` 模式保持当前行为（使用 fixture 预设响应）。
- `real` 模式不 mock `config.openai.chat.completions.create`，直接调用真实模型。
- `EvalResult` 增加指标：
  - `tokenUsage?: { prompt_tokens, completion_tokens, total_tokens }`
  - `planningMetrics?: { planCount, replanCount, retryCount, planStepCount }`
  - `reflectionCount`

#### 断言扩展 `packages/agent-core/src/eval/assertions.ts`

- 新增 `assertPlanEventContains(events, phrases)`：检查 plan 事件是否包含预期高层步骤。

#### 新场景 `packages/agent-core/src/eval/scenarios/real-model-planning.ts`

- 一个适合真实模型评估的 planning 场景。
- 使用 `requiredTools` 而不是 `expectedTools`。
- 检查最终回答质量和 plan 事件。

#### CLI 入口 `apps/cli/src/eval.ts`

- 支持 `--real` 参数切换到真实模型评估。

## 测试计划

每个阶段新增/更新测试：

1. `packages/agent-core/tests/planning/planning-agent-loop.test.ts`：计划绑定、工具偏离检测。
2. `packages/agent-core/tests/planning/task-judge.test.ts`：结构化 failureAnalysis。
3. `packages/agent-core/tests/planning/planner.test.ts`：层级计划解析。
4. `packages/agent-core/tests/eval/scenarios.test.ts`：真实模型场景（mock 模式）。

## 文档

- `docs/optimization-notes.md`：更新相关条目状态。
- `docs/phase4-summary.md`：补充规划增强说明。
- 可能新增 `docs/phase13-planning-enhancements.md` 统一记录。

## 验证标准

- `pnpm build` 通过
- `pnpm test` 全部通过
- 手动测试：
  1. 运行一个复杂任务，观察是否生成多步层级计划。
  2. 观察工具偏离时是否被检测并触发反思。
  3. 运行 `pnpm eval --real`（或对应命令）对真实模型跑评估。

## 提交信息

分阶段提交：

```text
feat: bind plan steps to tool execution and enforce expected tools
feat: add structured failure analysis to task judge
feat: support hierarchical plans with nested substeps
feat: support real-model evaluation with metrics
```