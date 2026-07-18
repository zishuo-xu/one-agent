# Phase 15：子 Agent（执行引擎 + 规划级并行委派）

> 文档状态：历史阶段快照（非当前多 Agent 产品路线）
> 阅读说明：本文记录受限子 Agent 首次实现；One Agent 仍是单主 Agent Runtime，不发展无约束递归编排。最新边界见 [项目现状](./project-vision-and-status.md)。

**日期**：2026-07-16
**状态**：✅ 已完成

---

## 目标

主 Agent 遇到复杂任务时拉起子 Agent：一次性、隔离上下文、工具可过滤、深度受限的委派执行。主 Agent 始终是唯一驱动者——子 Agent 是它的"一次工具调用"，不构成多 Agent 编排。

## 架构

```text
AgentLoop（主）
  ├─ spawn_agent 工具（模型自主调用）
  └─ delegate / parallel 计划步骤（Planner 标记）
       └─ SubAgentRunner.run(task)
            └─ new AgentLoop（全新 ContextManager + 过滤工具集 + 无 spawn_agent）
                 └─ SubAgentResult（reply / usage / toolCalls / durationMs）
```

### 关键设计

**递归阻断（构造上）**：AgentLoop 在 `depth < maxDepth`（默认 1）时把 spawn_agent 注册进**克隆的** ToolRegistry（绝不改动共享注册表）；子 Agent 以 depth=1 构造，其工具列表中天然没有 spawn_agent。

**并行安全（只读约束）**：`parallel` 步骤的子 Agent 只拿只读工具集
（`read_file / list_files / search_files / web_search / get_time`），从构造上消灭写冲突；
串行 `delegate` 步骤继承全工具。

**上下文隔离与注入**：子 Agent 不继承父历史，而是收到精心构造的 prompt
（总体目标 + 子任务 + 期望产出 + 长期记忆）；结果以 internal 消息回注父上下文，
供后续步骤与最终回答使用。

**观测**：`sub_agent` 事件（started / completed / failed，含 task、reply、error、
durationMs、tokenUsage）随父 run 落 trace；子 Agent token 消耗汇总进父 run 的
usage 统计。子 Agent 本身纯内存运行，不产生独立 thread。

## 波次调度（runPlanningLoop）

```text
flattenPlanPostOrder → buildExecutionUnits
  连续 delegate+parallel 步骤 → wave（Promise.allSettled 并行）
  其余 → single（delegate 时串行委派，否则原有 executeStep）
```

- 波次内失败步骤标 failed，整个波次经一次 Judge 判定（retry / replan / finalize）
- 重试只重置失败步骤；replan 后重新构建波次
- PlanStep schema 扩展：`delegate?: boolean`、`parallel?: boolean`（parallel 隐含 delegate）

## CLI 与 trace-web

- CLI：`[sub-agent] <task> … started / done (1.2s · 320 tokens) / FAILED: ...` 单行进度
- trace-web：sub_agent 事件独立配色 + 摘要（状态 + 耗时 + 任务 + 结果）

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/agents/SubAgentRunner.ts` `spawnAgentTool.ts` | 新增执行引擎与工具 |
| `src/agents/AgentLoop.ts` | subAgents 选项、registry 克隆、sub_agent 事件、buildExecutionUnits/executeWave/executeDelegatedStep |
| `src/planning/{types,Planner}.ts` | delegate/parallel 字段 + prompt 指引 |
| `apps/cli/src/chat-events.ts` | 子 agent 进度行 |
| `apps/trace-web/src/server.ts` | sub_agent 摘要 + 配色 |
| `tests/agents/*.test.ts` ×2 `tests/planning/delegated-steps.test.ts` | 新增 14 个测试 |

## 验证

- 全套 349 个测试通过（新增 14，零回归）
- 真实 DeepSeek 简单模式：模型自主调用 spawn_agent 委派读文件并汇总结果
- 真实 DeepSeek 规划模式：两个独立子任务被正确标记 delegate+parallel，
  **两个子 Agent 同时启动**（4.3s / 4.3s）、先后完成（7.4s / 8.4s），汇总正确

## 后续可选方向

- trace-web 嵌套展示：把子 Agent 的内部事件流挂到父事件下
- 子 Agent 模型降级：默认用 UTILITY_MODEL 跑子任务进一步省成本
- 并行写权限：声明式写文件清单 + 执行器交集校验（当前只读约束的放松版）
