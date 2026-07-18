# One Agent 项目 — 第三阶段总结报告

> 文档状态：历史阶段快照（非当前实现说明）
> 阅读说明：测试数量、文件结构和“下一步”只代表 Phase 3 完成时。最新事实见 [项目现状](./project-vision-and-status.md)，分类规则见 [文档索引](./README.md)。

**版本**：Phase 3 — 上下文与记忆管理  
**日期**：2026-07-13  
**技术栈**：TypeScript + pnpm + OpenAI-compatible SDK

---

## 一、阶段目标

解决「对话变长后上下文爆掉」的问题，实现 `ContextManager`，让单个 Agent 支持长对话不崩。

```text
对话增长 -> 超过阈值 -> 摘要旧消息 -> 保留 system + 摘要 + 近期消息 -> 继续
```

---

## 二、实现内容

### 2.1 新增 `ContextManager` 模块

**文件**：`packages/agent-core/src/context/ContextManager.ts`

核心职责：

- 维护完整对话历史
- 当历史超过阈值时，自动摘要旧消息
- 始终保留 system prompt + 旧消息摘要 + 最近 N 条消息

**配置项**：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `maxRecentMessages` | 10 | 保留的最近完整消息数 |
| `summaryTrigger` | 20 | 总消息数超过则触发摘要 |

**摘要策略**：

- 计算 `recentStart = messages.length - maxRecentMessages`
- 如果 `lastSummarizedIndex < recentStart`，说明有未摘要的旧消息
- 调用模型对旧消息做摘要，追加到已有摘要中
- 返回给模型的上下文：`system prompt + summary + 最近消息`

**摘要 prompt**：

```text
Summarize the following conversation concisely. Preserve key facts, decisions, and tool results.
```

### 2.2 `AgentLoop` 升级

**文件**：`packages/agent-core/src/agents/AgentLoop.ts`

- 不再直接维护 `messages: Message[]`
- 构造时接受可选的 `contextManager?: ContextManager`
- 默认自动创建一个 `ContextManager`
- 调用模型前执行 `await contextManager.buildContext()`
- 新增 `getContext()` 方法，返回当前发送给模型的上下文

### 2.3 CLI 增强

**文件**：`apps/cli/src/index.ts`

- 创建 `ContextManager` 并传给 `AgentLoop`
- 新增 `/context` 命令，查看当前发送给模型的上下文
- `/history` 命令仍显示完整历史

### 2.4 消息类型抽离

**文件**：`packages/agent-core/src/agents/types.ts`

把 `Message` / `MessageRole` 从 `AgentLoop.ts` 抽离，避免 `AgentLoop` 与 `ContextManager` 循环依赖。

---

## 三、测试覆盖

新增 `packages/agent-core/tests/context/ContextManager.test.ts`，6 个测试：

1. 短对话不触发摘要，返回完整历史
2. 长对话触发摘要，buildContext 返回 system + summary + 最近消息
3. system prompt 始终保留在开头
4. 摘要缓存复用，避免重复调用模型
5. 摘要失败时优雅降级（返回错误摘要信息）
6. tool_call / tool_result 在摘要中不丢失

**验证结果**：

```text
✓ agent-core: 32 个测试全部通过
✓ api: 2 个测试全部通过
✓ 总计：34 个测试全部通过
```

---

## 四、CLI 实测

```bash
pnpm dev:cli
```

输入 `/context` 可查看当前发送给模型的上下文：

```text
🤖 One Agent CLI
Model: glm-5.2
Tools: read_file, write_file, list_files, get_time
Workspace: /Users/.../one-agent/workspace

You: /context
--- Context sent to model ---
📋 system: You are a helpful assistant. ...
---
```

---

## 五、项目结构更新

```text
packages/agent-core/src/
├── agents/
│   ├── types.ts              # 消息类型（新抽离）
│   ├── AgentLoop.ts          # 接入 ContextManager
│   └── ...
├── context/
│   ├── ContextManager.ts     # 上下文管理核心
│   └── ...
└── tools/
    └── ...

apps/cli/src/index.ts         # 使用 ContextManager，新增 /context
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
```

---

## 七、后续计划

第四阶段 **规划与自我纠错**：

- 让 Agent 从「被动调用工具」升级为「先规划再执行，失败能自纠」
- 显式输出计划（Plan）
- ReAct 思路：Thought -> Action -> Observation
- 工具失败或结果不符时，反思并换方案
- 任务完成判定：不只是「模型不再调工具」，而是「目标达成」

---

## 八、设计要点

| 决策 | 选择 | 原因 |
|------|------|------|
| 阈值指标 | 消息数量 | 简单、可测试；接口预留 token 计算扩展 |
| 摘要模型 | 复用 `config.model` | 减少配置，先跑通 |
| 摘要消息角色 | `system` | 不污染 assistant/user 序列 |
| 增量摘要 | 缓存 `lastSummarizedIndex` | 避免重复调用模型，提升效率 |
| 工具对处理 | 摘要时保留 tool_call + tool_result 配对 | 避免模型看到孤立 tool call |
