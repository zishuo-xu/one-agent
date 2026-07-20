# Memory Document 设计

> 文档状态：当前有效
> 最后更新：2026-07-20

## 目标

One Agent 将长期记忆设计为用户拥有、可查看、可编辑的本地文档，而不是隐藏的模型状态或数据库记录。
原始会话和执行事实仍分别由 `messages` 与 Trace 保存；记忆文档只保留未来会话仍需要的精简内容。

## 两级长期记忆

```text
~/.one-agent/GLOBAL_MEMORY.md
    跨文件夹仍然成立的用户背景与偏好

<workspace>/.one-agent/MEMORY.md
    当前文件夹及其子目录共享的事实、决策、约束和约定

messages + trace
    当前会话上下文和原始证据，不创建第三份会话记忆文档
```

工作空间优先由 `--workspace` 指定；否则向上查找最近的 `one-agent.config.json` 或
`.one-agent/MEMORY.md`，没有标记时使用当前目录。

判断一条信息的作用域：换文件夹后仍成立则进入全局文档；换会话但仍在该文件夹时成立则进入工作空间文档；
只对当前任务成立则留在会话中。

## 运行时读取

`MemoryDocumentStore` 是长期记忆唯一事实源。每个 Run 重新读取两份文档，
`buildMemoryContext` 将其作为 JSON 数据包装后交给主 Agent、Planner 和 Sub-Agent 共用。
旧数据库中的 `memories` 只会被重命名为运行时不读取的 `memories_legacy` 回滚档案，新数据库不再创建记忆表。

优先级固定为：

```text
当前用户输入 > 当前会话 > 工作空间记忆 > 全局记忆
```

Markdown 内容只作为背景数据，不能成为系统指令、工具授权或越过 Tool Policy 的依据。
Trace 的 `memory_context_loaded` 事件只记录作用域、内容 hash、字符数和估算 token，不复制正文。

## 会话整理

切换、退出或启动恢复时，Memory Agent 一次读取完整用户可见 Thread 和两份最新文档，返回完整更新后的
`globalMemory` 与 `workspaceMemory`。Assistant 消息用于解释“可以，我认同”等指代，但只有用户消息能够授权记忆变化。
失败时不提交文件，`threads.memory_extracted` 保持 `0`，下次启动重新处理。

文件先提交，Thread 再标记完成。两步之间崩溃只会造成基于最新文档的幂等重试，不会丢失记忆。

## 本地并发

所有 One Agent 实例和 Web 编辑共用 `~/.one-agent/memory.lock`：

```text
获取独占锁
→ 读取两份最新文档与 hash
→ 模型整理或显式修改
→ 再次检查 hash
→ 临时文件写入并原子替换
→ 释放锁
```

外部编辑器不会遵守运行时锁，因此提交前必须再次检查 hash。发现用户直接编辑后，本次写入失败并等待重试，
绝不覆盖用户修改。锁超过安全时间可按陈旧锁清理；等待超时同样保持 Thread 未提取。

## 用户控制

- CLI：`/memory`、`/memory global`、`/memory workspace` 查看完整文档；
- API：`GET/PUT /api/memory/:scope` 读取或替换文档，PUT 可携带 `expectedHash`；
- Trace Web：Memory 面板查看和编辑两份文档，保存使用同一 hash 冲突保护；
- 对话：明确要求记住、纠正、忘记或检查时，`manage_memory` 直接追加、精确替换或删除文档文本。

Sub-Agent 只接收父 Run 已加载的文档快照，不直接读取或修改长期记忆。

## RAG 扩展边界

当前文档保持精简并整体注入。未来内容增长后，RAG 可以按 Markdown 标题切分两份文档，建立带 `global` / `workspace`
作用域的可重建索引，并只返回相关段落。向量、分块和缓存都是派生数据；Markdown 文档仍是唯一事实源，
记忆提取、用户编辑和 Agent 主流程不需要因此改变。
