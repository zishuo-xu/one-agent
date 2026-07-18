# Phase 16：子 Agent 观测性 + 模型降级

> 文档状态：历史阶段快照（非当前 Trace 完整说明）
> 阅读说明：本文保留嵌套 Trace 和 utility model 首次实现时的设计、测试数量与文件结构。最新事实见 [项目现状](./project-vision-and-status.md)，分类规则见 [文档索引](./README.md)。

**日期**：2026-07-13
**状态**：✅ 已完成

---

## 目标

收尾 Phase 15 留下的两个方向：

1. **嵌套 trace**：子 Agent 的内部事件流不再是黑盒——挂到父 run 的 `sub_agent`
   事件下，trace-web 展开即可查看子 Agent 自己的 thought / tool_call / tool_result。
2. **模型降级**：子 Agent 默认用 `UTILITY_MODEL`（更便宜）执行，主 Agent 保持主模型。

## 嵌套 trace

### 方案：嵌入父事件 payload

子 Agent 的浓缩事件流作为 `events` 字段嵌入父 run 的 `sub_agent` 完成事件：

```text
trace_events 行（父 runId）
  eventType: 'sub_agent'
  eventData: { status: 'completed', task, reply, durationMs, tokenUsage,
               events: [ {type:'tool_call',...}, {type:'tool_result',...}, {type:'message',...} ] }
```

**为何不选"子事件独立行落库"**：需要 `parent_event_id` 列（旧 DB 要迁移）、
spawn_agent 路径没有 stepId 作关联键、子行会混入 `getByRun` 扁平结果干扰所有
现有消费者。嵌入方案零迁移、零新路由，spawn / delegate 两条路径天然可用。

### 实现

- `SubAgentRunner.run()` 在 `chat()` 前订阅子 Agent 的 `'event'`  emitter 收集事件
  ——失败时也能拿到出错前的部分流（`chat()` 抛错后其返回值不可用）
- 浓缩规则：丢弃 `message_delta` / `reasoning_delta`（最终 `message` 事件已含全文，
  delta 纯噪音）；保留 `thought` / `reflection` / `tool_call` / `tool_result` / `message`
- `SubAgentResult.events` 携带浓缩流；`AgentLoopEvent` 的 `sub_agent` 变体新增
  `events?: AgentLoopEvent[]`；`started` 标记保持轻量不携带
- 波次并行天然无交错问题：每个完成事件携带各自子 Agent 的事件

### trace-web 渲染

- `sub_agent` 事件展开时显示嵌套子事件卡片（复用 `summarizeEvent` + delta 分组，
  按类型着色），与原始 JSON 并列
- 摘要行追加子事件计数：`completed (4.7s · 6 events)`
- 补齐既有缺口：`.timeline-seg.sub_agent` / `.filter-btn.sub_agent` 配色规则

## 模型降级

沿用 ContextManager 已建立的"显式 pin 优先"惯例，在 SubAgentRunner 构造点解析：

```typescript
const subAgentProvider =
  options.modelProvider ?? config.utilityModelProvider ?? this.modelProvider;
```

- 配置 `UTILITY_MODEL` 时子 Agent 用它；未配置时行为与之前完全一致
- 测试 / eval 显式 pin 的 provider 会传播给子 Agent（语义不变量保持）
- 不新增 AgentLoopOptions 字段：与 planning 模型的处理方式一致

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/agents/SubAgentRunner.ts` | 事件收集 + 浓缩 + `SubAgentResult.events` |
| `src/agents/AgentLoop.ts` | `sub_agent` 事件携带 events；模型降级解析 |
| `apps/trace-web/src/server.ts` | 嵌套渲染 + 子事件计数 + sub_agent 配色补缺 |
| `tests/agents/sub-agent-runner.test.ts` | +2：浓缩流断言、失败部分流 |
| `tests/agents/spawn-agent.test.ts` | +1：父 completed 事件携带子事件流 |
| `tests/model/purpose-models.test.ts` | +2：子 Agent 默认 utility-model、pin 传播 |
| `apps/trace-web/tests/server.test.ts` | +2：events round-trip、嵌套渲染标记 |

## 验证

- 全套 356 个测试通过（新增 7，零回归）
- 真实 DeepSeek：`UTILITY_MODEL` 配置下 spawn_agent 场景无回归；
  `--trace` 落库的 completed 事件携带完整 `events` 数组
