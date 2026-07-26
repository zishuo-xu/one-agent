# One Agent 文档索引与治理规则

> 文档状态：维护中
> 最后更新：2026-07-26

项目只保留当前仍参与维护、决策或可复现验证的文档。一次性计划、阶段总结、修复流水账和已经被当前规范
吸收的审查报告不长期保留；需要追溯时使用 Git 历史。

## 1. 当前有效的文档

以下文档需要随实现持续更新，发生冲突时按顺序确定当前事实：

1. [项目目标、愿景与设计现状](./project-vision-and-status.md)：产品定位、架构、能力边界、数据结构、已知限制的唯一事实源；
2. [Agent 项目接手指南](./agent-maintainer-guide.md)：面向开发 Agent 的架构地图、请求链路、改动路线与验证矩阵；
3. [根目录 AGENTS.md](../AGENTS.md)：整个仓库自动适用的精简协作规则和不可破坏的架构原则；
4. [配置清单](./configuration-reference.md)：环境变量、代码级 Runtime 参数、CLI 参数及默认值的唯一索引；
5. [Sub-Agent Evidence Contract](./sub-agent-evidence-contract.md)：委派输入输出协议、证据来源与非目标；
6. [Memory Document 设计](./memory-document-design.md)：全局/工作空间记忆、并发、提取与未来 RAG 边界；
7. [根 README](../README.md)：面向使用者的安装、启动、命令和能力入口；
8. 本索引：文档分类和维护规则。

源代码、数据库迁移与自动化测试是实现行为的最终证据。当前文档与代码不一致时，应先核对代码，再在同一修复提交中更新当前文档。

## 2. 保留的评测记录

评测报告只有在记录了不可由单元测试替代的真实实验时才长期保留：

- [能力评测 v2](../eval-results/2026-07-18-capability-eval-v2.md)：当前保留的最新完整能力基线；
- [真实进程恢复评测 v1](../eval-results/2026-07-18-recovery-eval-v1.md)

报告中的分数、耗时和 token 只描述当次实验。重新运行应新建报告；同类旧报告被更完整的新基线替代后可以删除，
Git 历史继续承担追溯职责。

## 3. 维护规则

1. 新功能或架构变更必须同步更新 `project-vision-and-status.md`；影响使用方式时同时更新根 README；
2. 新增或变更配置必须同步更新 SystemConfig Schema、`configuration-reference.md` 和 `one-agent.config.example.json`；
3. 改变模块职责、请求链路、验证命令或维护边界时，必须同步更新 `AGENTS.md` 和
   `agent-maintainer-guide.md`，避免新 Agent 依据过期路径工作。
4. 新评测写清模型、数据集、运行参数、代码提交和原始证据位置；
5. 临时计划、阶段总结、修复过程、代码审查流水账和用户 workspace 文件不进入长期文档；
6. 已完成工作的细节由 Git 提交、测试和 Trace 保存，不再额外生成一份“完成报告”；
7. 新文档必须有明确长期维护者和唯一用途；若内容能直接并入现有当前文档，就不要新建文件；
8. 纯文档修改至少检查相对链接并运行 `git diff --check`。
