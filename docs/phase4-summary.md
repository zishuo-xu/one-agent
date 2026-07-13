# One Agent 项目 — 第四阶段总结报告

**版本**：Phase 4 — 规划与自我纠错  
**日期**：2026-07-13  
**技术栈**：TypeScript + pnpm + OpenAI-compatible SDK

---

## 一、阶段目标

让 Agent 从「被动调用工具」升级为「先规划再执行，失败能自纠」。

```text
复杂任务 -> 拆解为计划 -> 逐步执行 -> 观察结果 -> 偏差则反思重试
```

---

## 二、实现内容

### 2.1 新增 `planning` 模块

**文件**：`packages/agent-core/src/planning/`

| 模块 | 文件 | 职责 |
|------|------|------|
| 类型 | `types.ts` | `Plan`、`PlanStep`、`ReasoningStep`、`JudgeResult` 等类型 |
| 规划器 | `Planner.ts` | 根据用户请求和可用工具生成执行计划 |
| 推理链 | `ReasoningChain.ts` | 记录 ReAct 推理链：Thought / Action / Observation |
| 任务判定 | `TaskJudge.ts` | 判断任务是否完成，决定继续/重试/重新规划/结束 |

### 2.2 `Planner`：显式规划

- 通过模型调用生成 JSON 格式计划
- 计划包含 `reasoning` 和多 `steps`
- 每个步骤包含 `id`、`description`、`toolName`（可选）、`expectedOutcome`
- 若模型不返回合法 JSON，回退为单步计划「直接响应用户」

### 2.3 `ReasoningChain`：记录推理链

- `addThought`：记录模型思考
- `addAction`：记录工具调用
- `addObservation`：记录工具结果
- `addReflection`：记录反思
- `toMessages()`：将推理链转换为 `Message[]` 供模型消费

### 2.4 `TaskJudge`：任务判定与自我纠错

- 输入当前计划和执行历史
- 输出：
  - `complete`：是否完成
  - `nextAction`：`continue` / `retry` / `replan` / `finalize`
- 限制最大重新规划次数和重试次数，避免无限循环

### 2.5 `AgentLoop` 重构

`packages/agent-core/src/agents/AgentLoop.ts`：

- 新增 `enablePlanning` 选项，默认启用
- 保持 `enablePlanning: false` 时行为与 Phase 2 相同
- 启用 planning 时，内部循环分为：
  1. **Planning 阶段**：生成计划
  2. **Execution 阶段**：逐步执行，记录 Thought/Action/Observation
  3. **Judging 阶段**：判定是否完成、重试或重新规划
- 新增 `getReasoningChain()` 方法

### 2.6 CLI 增强

`apps/cli/src/index.ts`：

- 展示 `[计划]` 事件
- 展示 `[思考]` 事件
- 展示 `[反思]` 事件
- 展示 `[调用工具]` / `[工具结果]` 事件
- 新增 `/reasoning` 命令查看当前推理链
- 保留 `/history` 和 `/context` 命令

### 2.7 API 增强

`apps/api/src/routes/chat.ts`：

- 接入 `ToolRegistry` 和 `ContextManager`
- 每个请求创建新的 `AgentLoop`（当前仍无会话状态）
- 返回 `reply` 和 `events`，包含 planning 事件

---

## 三、测试覆盖

新增 `packages/agent-core/tests/planning/`：

- `planner.test.ts`：生成计划、JSON 解析失败回退、模型调用失败回退
- `reasoning-chain.test.ts`：记录 thought/action/observation、转 messages、commit 步骤
- `task-judge.test.ts`：判定结果解析、重试/重规划次数限制、错误回退
- `planning-agent-loop.test.ts`：
  - 生成计划并执行单步
  - JSON 解析失败回退
  - 失败步骤重试并完成任务

**验证结果**：

```text
✓ agent-core: 45 个测试全部通过
✓ api: 2 个测试全部通过
✓ 总计：47 个测试全部通过
```

---

## 四、CLI 实测

输入：

```text
请帮我读取 notes.txt，然后总结一下它说了什么
```

输出（计划回退场景）：

```text
[计划]
1. Respond to: 请帮我读取 notes.txt，然后总结一下它说了什么
Reasoning: Directly respond to the user request. (Plan parsing failed)
[调用工具] read_file: {"path":"notes.txt"}
[工具结果] {"success":true,"data":{"content":"Hello from workspace\n"}}

Agent: 已读取 notes.txt，内容仅有一行：“Hello from workspace”。
总结：该文件是工作区中的一个简单测试或占位文件。
```

**说明**：当前使用的 `glm-5.2` 模型对严格 JSON 格式输出支持不稳定，Planner 会回退到单步计划。后续可针对模型优化 prompt 或改用支持 `response_format: json_object` 的模型。核心架构（计划 → 执行 → 判定）已就绪。

---

## 五、项目结构更新

```text
packages/agent-core/src/
├── agents/
│   ├── types.ts
│   └── AgentLoop.ts              # 支持 planning 模式
├── context/
│   └── ContextManager.ts
├── planning/
│   ├── types.ts
│   ├── Planner.ts
│   ├── ReasoningChain.ts
│   └── TaskJudge.ts
└── tools/
    └── ...

apps/cli/src/index.ts            # 展示 planning 事件
apps/api/src/routes/chat.ts      # 接入 tools + ContextManager
```

---

## 六、Git 提交记录

```text
66dad41 feat: add basic agent loop
f3bba47 chore: ignore generated files and plan metadata
8c36ee4 docs: add README and env example
74fc2a2 refactor: extract agent-core and add CLI REPL
edde385 fix: load .env before agent-core config in CLI/API
7b9e036 feat: add tool registry and built-in file tools
55fda16 feat: add get_time tool as built-in example
d2f29d8 feat: add context manager with summarization
<Phase 4 commit>
```

---

## 七、后续计划

第五阶段 **SQLite 持久化**：

- 把 `threads / messages / tool_calls / agent_runs` 写入 SQLite
- 学习 Thread 与 Message 关系、run 生命周期、失败恢复
- 任务状态：`pending`、`running`、`completed`、`failed`、`cancelled`
- 让 CLI 支持跨会话记忆

---

## 八、设计要点

| 决策 | 选择 | 原因 |
|------|------|------|
| planning 模式 | 默认启用 | 用户选择，每个任务都先尝试规划 |
| 计划回退 | 单步「直接响应」 | 兼容不支持 JSON 输出的模型 |
| 推理链 | 显式记录 | 便于观察、调试、后续 Trace |
| 任务判定 | 模型判定 | 让 Agent 自主决定完成/重试/重规划 |
| 失败控制 | 限制最大重试和重规划次数 | 防止无限循环 |

---

## 九、已知限制与后续优化

1. **Planner JSON 输出稳定性** ✅ 已优化：
   - 使用 `response_format: { type: 'json_object' }` 约束模型输出。
   - 解析前剥离 markdown 代码块、提取首个 JSON 对象，兼容模型带前缀说明或包裹 JSON 的情况。
   - 在 prompt 中加入 one-shot 示例，强化格式预期。
   - 对 `TaskJudge` 同样使用 JSON 提取，避免判定阶段解析失败。
   - 若模型仍返回非法 JSON，仍回退为单步计划。

2. **计划步骤与工具调用不完全绑定**：模型即使计划中没有指定工具，也可能在执行步骤时调用工具。这是合理的 ReAct 行为，但需进一步评估。

3. **API 仍无会话状态**：每次请求新建 `AgentLoop`，Phase 5 持久化将解决此问题。

