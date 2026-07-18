# 架构重构：可读性与可扩展性（2026-07-17）

> 文档状态：历史工程记录（非当前架构规范）
> 本文记录 2026-07-17 当时的重构快照，其中代码行数和测试数量是历史数据。项目当前架构、能力与限制以 [项目现状](./project-vision-and-status.md)为准，分类规则见 [文档索引](./README.md)。

**目标**：简洁不是行数少，而是**可读性强、可扩展能力高**。让"加功能"从"改上帝类"变成"加一个文件"。
**原则**：只动真正纠缠的地方（AgentLoop 一处），`planning/ tools/ db/ context/ model/` 五个边界健康的包零改动；无 DI 框架、无"万物皆接口"。

---

## 一、重构前

`AgentLoop.ts` 单文件 1428 行，混合六种职责：

- 编排：简单循环 + 规划循环（units/wave/delegate/replan）
- 模型调用：两个近乎重复的流式实现（孪生陷阱——reasoning 重复显示 bug 就是只修了一处）
- 运行记录：事件流、trace 持久化、delta 聚合、token 记账
- 子 Agent 委派、持久化、记忆联动
- 扩展点靠手术：新循环模式/新事件 sink/新重试策略都要进 AgentLoop 动刀
- 隐式状态：ReasoningChain 的 ambient `currentStep`（波次并发覆盖竞态的根源）

## 二、重构后结构

```
agents/
  AgentLoop.ts         门面（467 行）：装配、chat 分派、记忆联动、对外 API
  ModelCaller.ts       模型调用的唯一入口（207 行）：流式/非流式、重试、
                       tool-call 增量拼装、reasoning 回退、usage 回报
  RunRecorder.ts       一次 run 的全部记录（134 行）：事件流、trace 持久化
                       （delta 聚合缓冲）、token 记账
  SubAgentRunner.ts    隔离子 Agent 执行（原有，不动）
  loops/
    types.ts           LoopInfrastructure（共享基础设施）+ LoopStrategy（扩展点）
    utils.ts           safeParseArgs 等纯函数
    SimpleLoop.ts      直接工具循环（115 行）
    PlanningLoop.ts    规划引擎（703 行）：units/wave/delegate/replan/finalize
planning/              ReasoningChain 改显式分桶（见下）；Planner/TaskJudge 不动
model/                 新增 MockProvider（eval/测试确定性回放）
tools/built-in/        静态工厂列表（替代目录自扫描）
```

## 三、角色职责与扩展点

| 角色 | 一句话职责 | 扩展故事 |
|------|-----------|----------|
| `AgentLoop`（门面） | 选项装配与一次 chat 的生命周期 | 30 秒看懂主流程；对外 API 完全不变 |
| `ModelCaller` | "怎么跟模型说话"的唯一答案 | 新重试/缓存/日志策略只进这一个文件 |
| `RunRecorder` | "一次 run 留下了什么"的唯一答案 | 新观测 sink（metrics/OTel）= 加一个 `onEvent` 订阅 |
| `LoopStrategy` | 一种执行策略（现有 simple/planning 两种） | **新循环模式 = 新文件实现 `run()` + 门面注册一行**（计划审批、ReAct 变体都有家了） |
| `ReasoningChain` | 运行推理痕迹，按 planStepId 显式分桶 | 并发步骤写独立桶，归属确定，无并发覆盖 |

## 四、关键设计决策

1. **基础设施共享**：两个循环共用同一份 `LoopInfrastructure`（context/models/recorder/tools/planner/judge/subAgentRunner），门面一次性装配；循环类构造时把 infra 字段展开为同名字段，迁移代码几乎零改写。
2. **ReasoningChain 显式分桶**：所有写入方法带可选 `planStepId`（替代 `setCurrentPlanStepId` 环境状态）。并行波次各写独立桶，竞态从结构上消除；`addObservation`/`addFailureAnalysis` 提交本桶，`commitStep` 冲刷残桶——提交语义只有一句话。
3. **pin 优先的一致性**：显式 pin 的 `modelProvider` 对主循环/planner/judge/sub-agent/摘要/分类器全部生效（此前 planner/judge 是漏网之鱼，MockProvider 注入后必须补上）。
4. **eval 无全局态**：`MockProvider` 依赖注入替代 `config.openai` monkey-patch——任务隔离、可并行，"新增内部调用挤占 mock 槽位"的脆弱性只保留在测试自身的 vi.mock 层。

## 五、迁移提交（每步全套测试绿色）

```
0323d94 步骤1：提取 ModelCaller（流式孪生合并 + 死代码清理）
fcc8048 步骤2：提取 RunRecorder（事件/trace/记账）
f0bb9c6 步骤3：SimpleLoop/PlanningLoop 分离 + 门面化
8848c66 步骤4a/4b：静态工具列表 + ReasoningChain 显式分桶
e043e88 步骤4c：eval MockProvider 注入
```

## 六、验证

- 全套 **382 测试**（agent-core 283 / api 27 / cli 62 / trace-web 10）+ eval 30/30 + CLI eval 20/20 + build
- 真实模型 E2E 四场景：工具链多轮、规划多步、子 Agent 波次、记忆跨 thread 召回
- 死代码清理：TaskJudge 计数器 API、`ReasoningChain.toMessages`、`JudgeOptions` 死字段、工具目录扫描器

## 七、后续可选项（暂未做，不影响本架构）

- 计划审批循环（`PlanReviewLoop`：实现 `LoopStrategy` 即可，门面注册一行）
- RunRecorder 加 metrics/OTel sink
- PlanningLoop 进一步拆 wave/delegate 子模块（当前 703 行内聚可读，暂不需要）
