# One Agent 文档索引与治理规则

> 文档状态：维护中
> 最后更新：2026-07-20

本页解决一个问题：项目迭代很快，但历史阶段报告中的“当前”“下一步”和测试数量只代表当时，不能继续充当今天的规范。

## 1. 当前有效的文档

以下文档需要随实现持续更新，发生冲突时按顺序确定当前事实：

1. [项目目标、愿景与设计现状](./project-vision-and-status.md)：产品定位、架构、能力边界、数据结构、已知限制的唯一事实源；
2. [配置清单](./configuration-reference.md)：环境变量、代码级 Runtime 参数、CLI 参数及默认值的唯一索引；
3. [Sub-Agent Evidence Contract](./sub-agent-evidence-contract.md)：委派输入输出协议、证据来源与非目标；
4. [Memory Document 设计](./memory-document-design.md)：全局/工作空间记忆、并发、提取与未来 RAG 边界；
5. [根 README](../README.md)：面向使用者的安装、启动、命令和能力入口；
6. [项目学习路线](../SIMPLIFIED_AGENT_PROJECT_ROADMAP.md)：阶段脉络和候选学习方向，不替代现状文档；
7. 本索引：文档分类和维护规则。

源代码、数据库迁移与自动化测试是实现行为的最终证据。当前文档与代码不一致时，应先核对代码，再在同一修复提交中更新当前文档。

## 2. 历史阶段快照

下列文档保留每个学习阶段完成时的设计、测试数量和当时的后续计划。它们不会被改写成最新架构；文中的“当前”“尚未实现”“下一步”均以文档日期为准。

- [Phase 1 架构设计](./phase1-architecture.md) / [Phase 1 总结](./phase1-summary.md)
- [Phase 2：Tool Calling](./phase2-summary.md)
- [Phase 3：上下文管理](./phase3-summary.md)
- [Phase 4：规划与自我纠错](./phase4-summary.md)
- [Phase 5：SQLite 持久化](./phase5-persistence.md)
- [Phase 6：异步任务与流式输出](./phase6-async-streaming.md)
- [Phase 7：Trace 与 Evaluation](./phase7-trace-evaluation.md)
- [Phase 8：全局 CLI](./phase8-global-cli.md)
- [Phase 9：任务持久化](./phase9-task-persistence.md)
- [Phase 10：长期记忆](./phase10-memory.md)
- [Phase 11：规划增强](./phase11-planning-enhancements.md)
- [Phase 12：多模型抽象](./phase12-multi-model.md)
- [Phase 13：工具生态](./phase13-tool-ecosystem.md)
- [Phase 14：Eval 与 Trace 联动](./phase14-eval-trace.md)
- [Phase 15：受限子 Agent](./phase15-sub-agents.md)
- [Phase 16：子 Agent 观测性](./phase16-sub-agent-observability.md)
- [Phase 17：能力评测基础设施](./phase17-capability-eval.md)

## 3. 历史工程记录

这些文档用于解释某次审查、故障、修复或重构为何发生，不承担当前规范职责：

- [CLI 交互改进](./cli-interaction-improvements.md)
- [CLI UX 优化](./cli-ux-optimization.md)
- [核心正确性修复](./correctness-fixes.md)
- [功能全景审查](./feature-review-2026-07.md)
- [功能测试报告](./functional-test-report-2026-07.md)
- [功能测试反馈修复](./fixes-functional-test-2026-07.md)
- [自主测试与修复报告](./autonomous-test-fix-report-2026-07.md)
- [架构重构快照](./architecture-refactor-2026-07.md)
- [阶段优化记录](./optimization-notes.md)

## 4. 不可变评测记录

评测报告记录一次指定模型、数据集、代码版本和参数下的结果。旧报告不覆盖；重新运行必须新建版本文件。

- [能力评测 v1](../eval-results/2026-07-17-capability-eval-v1.md)
- [能力评测 v2](../eval-results/2026-07-18-capability-eval-v2.md)
- [真实进程恢复评测 v1](../eval-results/2026-07-18-recovery-eval-v1.md)

报告中的分数、耗时、token 和“下一步”只描述当次实验。当前能力结论以现状文档和最新同类评测报告为准。

## 5. 维护规则

1. 新功能或架构变更必须同步更新 `project-vision-and-status.md`；影响使用方式时同时更新根 README；
2. 阶段文档和工程报告一经归档，不为追赶现状重写正文。发现原记录有事实错误时追加“勘误”，并保留原实验语境；
3. 新评测使用新文件并写清模型、数据集、运行参数、代码提交和原始证据位置；
4. 历史文档必须带统一状态提示，并链接到本索引和当前事实源；
5. 临时任务产物、模型生成报告和用户 workspace 文件不进入项目文档索引，除非经过人工确认并明确纳入项目范围；
6. 文档修改与对应实现使用同一提交；纯治理修改使用独立 `docs:` 提交并说明未改变 Runtime。
7. 新增或变更配置必须同步更新 SystemConfig Schema、`configuration-reference.md` 和 `one-agent.config.example.json`。
