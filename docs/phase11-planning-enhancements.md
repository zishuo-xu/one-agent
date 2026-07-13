# Phase 11：规划能力深度增强

**日期**：2026-07-13  
**目标**：一次性增强 Agent 的规划与评估能力，让计划与执行真正绑定、支持层级拆解、结构化反思，并能在真实模型上跑评估。

---

## 一、新增/改造能力

### 1. 计划与执行绑定

**问题**：之前 Planner 生成计划后，每步执行时模型仍可自由决定调用什么工具，计划只是“建议”。

**做法**：
- `PlanStep` 新增可选约束字段：
  - `toolName`：建议工具，会映射为 `requiredTool` 并默认开启 `strict`。
  - `requiredTool`：强制必须使用的工具。
  - `allowedTools`：允许使用的工具白名单。
  - `strict`：严格模式，工具偏离即标记步骤失败。
- `AgentLoop.executeStep` 根据当前步骤的约束，仅把允许的 tools schema 传给 `callModel`。
- 模型返回 tool calls 后，检查是否偏离计划；若偏离且 `strict=true`，记录结构化 `failureAnalysis`，并将步骤标记为 `failed`，触发 Judge 决定 retry / replan / finalize。

**文件**：
- `packages/agent-core/src/planning/types.ts`
- `packages/agent-core/src/agents/AgentLoop.ts`
- `packages/agent-core/src/tools/registry.ts`（新增 `getSchemas(toolNames?)` 支持子集 schema）

---

### 2. 子目标拆解（层级计划）

**问题**：之前的计划只有平级步骤，复杂任务难以表达“先完成 A.1、A.2，再汇总 A，最后做 B”。

**做法**：
- `Planner` 的 JSON schema 支持递归 `children`。
- Prompt 中给出 children 示例，引导模型对复杂步骤拆分子步骤。
- `Planner.prepareStep` 递归为子步骤设置 `parentId` 和 `status: 'pending'`。
- `AgentLoop` 新增 `flattenPlanPostOrder()`，将层级计划按后序遍历展开为执行顺序：子步骤 → 父步骤 → 兄弟步骤。
- 父步骤执行前检查子步骤状态：若任一子步骤失败，父步骤直接标记失败并进入反思/重规划。

**文件**：
- `packages/agent-core/src/planning/Planner.ts`
- `packages/agent-core/src/agents/AgentLoop.ts`

---

### 3. 结构化反思 / 失败分析

**问题**：之前的 reflection 只是简单字符串，Judge 输出也只有 `complete` / `nextAction`，缺少失败根因和建议。

**做法**：
- 新增 `FailureAnalysis` 类型：
  - `category`: `'tool_failure' | 'plan_mismatch' | 'missing_info' | 'wrong_args' | 'other'`
  - `affectedStepIds`: 受影响的 plan step id 列表
  - `rootCause`: 根因
  - `recommendation`: 修复建议
- `TaskJudge` 的 JSON schema 和 prompt 都扩展 `failureAnalysis` 字段。
- `AgentLoop` 在以下场景生成 `FailureAnalysis`：
  - 工具偏离计划（`plan_mismatch`）
  - 子步骤失败导致父步骤失败（`tool_failure`）
- `AgentLoop.replan()` 接收 `failureAnalysis`，将其作为上下文传给 `Planner.createPlan`，新计划能更精准地规避之前失败。

**文件**：
- `packages/agent-core/src/planning/types.ts`
- `packages/agent-core/src/planning/TaskJudge.ts`
- `packages/agent-core/src/planning/ReasoningChain.ts`（新增 `addFailureAnalysis`）
- `packages/agent-core/src/agents/AgentLoop.ts`

---

### 4. 真实模型评估

**问题**：之前的 `EvalRunner` 只用于 mock 回归，无法对真实模型跑 benchmark。

**做法**：
- `EvalRunnerOptions` 增加 `mode?: 'mock' | 'real'`。
- `EvalResult` 增加指标：
  - `tokenUsage`：预留，待后续接入 token 统计
  - `planningMetrics`：`planCount`、`replanCount`、`retryCount`、`planStepCount`
  - `reflectionCount`：反思事件数
- `EvalRunner` 从 `plan` 和 `reflection` 事件自动计算上述指标。
- 新增 `assertPlanEventContains(events, phrases)` 断言，检查 plan 中是否包含预期高层步骤。
- 新增场景 `real-model-planning`：
  - 使用 `requiredTools` 而不是 `expectedTools`（更容忍真实模型的非确定性）。
  - 检查最终回答是否包含关键信息。
- CLI `apps/cli/src/eval.ts` 支持 `--real` 参数，仅运行真实模型场景。

**文件**：
- `packages/agent-core/src/eval/types.ts`
- `packages/agent-core/src/eval/runner.ts`
- `packages/agent-core/src/eval/assertions.ts`
- `packages/agent-core/src/eval/scenarios/real-model-planning.ts`
- `packages/agent-core/src/eval/scenarios/index.ts`
- `packages/agent-core/src/index.ts`（导出 `realModelPlanningTask`）
- `apps/cli/src/eval.ts`

---

## 二、测试覆盖

| 测试文件 | 覆盖点 |
|----------|--------|
| `packages/agent-core/tests/planning/reasoning-chain.test.ts` | `planStepId` 绑定、按 plan step 查询、`failureAnalysis` 记录 |
| `packages/agent-core/tests/planning/planning-agent-loop.test.ts` | 工具偏离检测与重试、allowedTools 限制、层级计划深度优先执行 |
| `packages/agent-core/tests/planning/task-judge.test.ts` | `failureAnalysis` 解析与非法 shape 回退 |
| `packages/agent-core/tests/planning/planner.test.ts` | 层级 plan 解析、children 与 parentId 设置 |
| `packages/agent-core/tests/eval/scenarios.test.ts` | `real-model-planning` 在 mock 模式下通过，并验证 planning metrics |

---

## 三、验证结果

- `pnpm build` 通过
- `pnpm test` 全部通过：
  - `agent-core`: 30 个测试文件，151 个测试
  - `api`: 4 个测试文件，27 个测试
  - `cli`: 3 个测试文件，12 个测试
  - `trace-web`: 1 个测试文件，7 个测试

---

## 四、提交信息

本次 Phase 11 分 4 个阶段提交：

```text
feat: bind plan steps to tool execution and enforce expected tools
feat: add structured failure analysis to task judge
feat: support hierarchical plans with nested substeps
feat: support real-model evaluation with metrics
```

---

## 五、后续可继续优化

1. **token 统计**：当前 `tokenUsage` 未接入，后续可在 `AgentLoop` 记录每次模型调用的 `usage` 并汇总到 `EvalResult`。
2. **规划开关粒度**：按任务类型自动判断是否启用 planning（简单问题直接回答，复杂问题才规划）。
3. **失败案例集**：真实模型评估失败时自动保存相关 trace 到失败案例集，用于 prompt 迭代。
4. **Replan 次数精细化管理**：当前 `replanCount` 是 `planCount - 1`，后续可精确区分重试和重规划。
