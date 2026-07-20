# Phase 10：会话级长期记忆

> 文档状态：历史阶段快照（保留当前记忆设计的详细背景，但不作为唯一规范）
> 阅读说明：本文记录 2026-07-18 的数据库记忆方案，已被 2026-07-20 的 [Memory Document 设计](./memory-document-design.md)取代；当前行为以 [项目现状](./project-vision-and-status.md)为准。

**日期**：2026-07-18
**状态**：✅ 已实现

## 目标

One Agent 将完整历史、执行过程和长期记忆分开：`messages` 保存对话证据，`trace_events` 保存执行事实，
`memories` 只保存未来对话真正需要的长期信息。记忆整理不能影响主 Agent 的回答质量与时延。

## 核心设计

```text
用户正常对话
→ messages 持久化用户消息，并把 Thread 标记为未提取
→ 主 Agent 独立完成回答，不调用记忆模型
→ 切换/退出时整理当前 Thread
→ 启动时恢复全部未提取 Thread
→ Memory Agent 一次读取该 Thread 的全部用户消息
→ Runtime 校验证据、合并冲突并标记已提取
```

日常操作只处理正在离开的一个 Thread；全局扫描只发生在启动恢复阶段。合法的 `[]` 表示成功判断“没有长期记忆”，
也会把 Thread 标记为已提取。模型、JSON 或数据库失败则保持未提取，下一次启动自动重试。
CLI 的 `/exit`、`/quit`、输入流关闭和空闲时普通 `Ctrl-C` 都走同一条优雅关闭整理路径；连续中断仍可强制退出。

## 数据结构

`threads` 只增加一个状态：

```text
memory_extracted = 0  未提取或上次失败
memory_extracted = 1  已成功提取（包括空结果）
```

`memories` 保持单表，并记录：

- `kind`：用户背景、偏好、项目规则、长期目标或兼容事实；
- `explicit`：用户是否明确表达；
- `source_message_id`：唯一事实证据；
- `observed_at`：原始用户消息发生时间；
- `scope`、`confidence`、`status`、`expires_at`、`superseded_by_id` 等治理字段。

旧 Thread 在升级时默认标记为已提取，避免一次记忆清理后又自动导入历史测试会话；之后只要收到新的用户消息，
`MessageStore` 就在保存消息的同一事务中把该 Thread 重新标记为未提取并刷新版本时间。如果整理期间又收到新消息，
本轮可以写入已确认的候选，但不会把 Thread 错误标记为已提取；下一次会重新读取完整会话。

## Memory Agent

Memory Agent 的一次调用单位是一个完整 Thread，但输入只包含用户消息，不包含 Assistant 回复、reasoning、工具结果、
搜索结果或文件内容。允许提取用户长期背景、稳定偏好、项目规则和长期目标；拒绝普通知识、临时任务、预测和凭据。

每个候选必须引用本次输入中的 `sourceMessageId`。无法提供原始用户证据、返回非法 JSON 或伪造消息 ID，整个整理视为失败，
Thread 保持未提取。密码、Token、API Key 和私钥还会在写入前由 Runtime 再次拒绝。

## 顺序无关冲突处理

事实新旧由 `observed_at` 决定，而不是 `created_at`：

```text
7 月 1 日旧会话：用户使用 npm
7 月 10 日新会话：用户改用 pnpm
7 月 20 日才补处理旧会话
→ pnpm 保持 active，npm 只能保存为 superseded
```

相同事实增强现有记录；冲突事实依次比较原始消息时间、明确程度、置信度和稳定证据 ID，保证处理顺序不同仍得到相同结果。

## 召回与可观察性

召回按关键词/中文 bigram 找出候选，再过滤状态、作用域、过期时间和数量上限，并按明确程度、置信度和事实时间排序。
每轮在 Run 建立后写入一条 `memory_recall` Trace，记录：

- 查询关键词及无有效关键词等跳过原因；
- 所有匹配候选的记忆 ID、键、类型、作用域、状态、命中关键词和排序元数据；
- `selected`、`filtered_inactive`、`filtered_expired`、`filtered_scope`、`filtered_limit` 等结果；
- 最终注入的记忆 ID、字符数和估算 token 数。

Trace 不复制记忆值，既能通过 ID 回查证据，又避免在观察层额外扩散用户事实。每轮召回前会清除上一轮的记忆上下文，
无命中时不会继续携带旧记忆。Memory Consolidation 的开始、成功和失败也写入 Trace。这些观察事件写入失败不会改变主任务结果；后续加入的恢复点属于必须持久化的关键 Trace。

`memory-eval-datasets/recall-v1.json` 提供 6 个确定性离线基线，覆盖英文召回、无空格中文、无关问题、Thread 作用域、
失效记忆过滤和显式事实排序。它用于判断当前关键词方案是否退化，也为未来是否引入 FTS5 或语义检索提供对照。

## 设计边界

- 不在每轮回答后额外调用模型；
- 不从 Agent 回复中生成用户事实；
- 不新增记忆候选表或后台任务表；
- 不引入向量/图数据库；
- 不根据记忆或 Trace 自动优化 Agent；
- 不让记忆失败改变主任务结果。

## 当前限制

- 超长 Thread 当前整体交给模型，超过模型上下文时会保持未提取并等待后续容量策略；
- API 没有显式“切换/关闭 Thread”端点，主要依赖消息变更标记和服务启动恢复；
- 当前评测集验证确定性召回，不评估 Memory Agent 模型提取的语义准确率；
- 关键词检索是否需要升级为 SQLite FTS5 或语义检索，应由扩充后的记忆评测数据决定。
