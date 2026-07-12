# Phase 3 实施计划：上下文与记忆管理

基于更新后的 `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`，本阶段目标是在单一 Agent 内解决「对话变长后上下文爆掉」的问题，新增 `ContextManager`，让 `AgentLoop` 支持长对话不崩。

## 一、目标

实现 `ContextManager`：

- 保存完整对话历史
- 当历史超过阈值时，自动摘要旧消息
- 始终保留 system prompt + 最近 N 条消息 + 旧消息摘要
- 对 `AgentLoop` 透明，只替换消息组装逻辑

```text
对话增长 -> 超过阈值 -> 摘要旧消息 -> 保留 system + 摘要 + 近期消息 -> 继续
```

## 二、新增模块

### 1. `packages/agent-core/src/context/ContextManager.ts`

核心类，职责：

- 维护完整 `Message[]` 历史（`addMessage`）
- 提供 `buildContext()` 返回给模型看的消息列表
- 触发摘要压缩（`summarize`）
- 保留工具调用对（tool_call + tool_result）不拆散

接口草案：

```ts
interface ContextManagerOptions {
  systemPrompt: string;
  maxRecentMessages?: number;    // 默认 10，最近保留的原始消息数
  summaryTrigger?: number;       // 默认 20，总消息数超过则触发摘要
  summaryModel?: string;         // 默认同 config.model
}

class ContextManager {
  addMessage(message: Message): void;
  buildContext(): Promise<Message[]>;  // 按需摘要后返回上下文
  getHistory(): Message[];             // 返回完整历史
  clear(): void;
}
```

摘要策略：

- 当完整历史超过 `summaryTrigger` 条时，把除 system 和最近 `maxRecentMessages` 外的旧消息发给模型做摘要
- 用一条 `system` 消息保存摘要，例如：`Earlier conversation summary: ...`
- 最终给模型的上下文：
  - system prompt
  - summary message（如果已摘要）
  - 最近 `maxRecentMessages` 条完整消息

摘要 prompt：

```text
Summarize the following conversation concisely. Preserve key facts, decisions, and tool results.
```

### 2. `packages/agent-core/src/context/types.ts`（可选）

若类型较多，可拆出 `ContextManagerOptions`、`Summary` 等类型。若简单则直接放在 `ContextManager.ts` 中。

## 三、修改现有模块

### 1. `packages/agent-core/src/agents/AgentLoop.ts`

- 构造时接受 `contextManager?: ContextManager`
- 内部不再直接维护 `messages: Message[]`，而是调用 `contextManager.addMessage()`
- `callModel()` 前调用 `await contextManager.buildContext()`
- `getHistory()` 委托给 `contextManager.getHistory()`
- 保留 `events` 记录不变

### 2. `packages/agent-core/src/index.ts`

- 导出 `ContextManager` 和相关类型

### 3. `apps/cli/src/index.ts`

- 创建 `ContextManager` 实例并传给 `AgentLoop`
- `/history` 命令显示完整历史（不变）
- 可选新增 `/context` 命令，显示当前发送给模型的上下文

### 4. `apps/api/src/routes/chat.ts`

- 当前 API 仍是每次请求新建 `AgentLoop`，无会话状态，所以暂时用不上 `ContextManager`
- 但可通过构造时传入 `ContextManager` 来支持未来 `threadId` 扩展，本次不做大改

## 四、技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 阈值指标 | 消息数量（默认 20 条触发摘要） | 简单、可测试、避免引入 tokenizer 依赖；接口预留 token 计算扩展 |
| 摘要模型 | 复用 `config.model` | 减少配置，先跑通；后续可支持 cheap summary model |
| 保留最近消息数 | 10 条 | 保证模型有近期完整上下文 |
| 摘要消息角色 | `system` | 不污染 assistant/user 序列，模型容易识别为全局背景 |
| 工具对处理 | 摘要时把 `tool_call` + 对应 `tool_result` 作为整体描述 | 避免模型看到孤立 tool call |

## 五、测试计划

新增 `packages/agent-core/tests/context/ContextManager.test.ts`：

1. 短对话不触发摘要，返回完整历史
2. 长对话触发摘要，buildContext 返回 system + summary + 最近消息
3. system prompt 始终保留在开头
4. tool_call/tool_result 配对在摘要中不丢失
5. `AgentLoop` 集成测试：mock 模型调用，验证传给模型的消息数被压缩

更新 `packages/agent-core/tests/agent-loop.test.ts`：

- 由于 `AgentLoop` 构造可能改为接收 `ContextManager`，现有测试用默认 manager 即可保持通过

## 六、文件变更清单

```text
新增：
  packages/agent-core/src/context/ContextManager.ts
  packages/agent-core/tests/context/ContextManager.test.ts

修改：
  packages/agent-core/src/agents/AgentLoop.ts
  packages/agent-core/src/index.ts
  apps/cli/src/index.ts
  docs/phase1-architecture.md（可选更新衔接说明）
```

## 七、Git 提交

```text
feat: add context manager with summarization
```

## 八、阶段产出验证

- `pnpm build` 通过
- `pnpm test` 全部通过
- CLI 长对话测试：连续对话 30 轮后，模型仍收到 system + summary + 最近消息，不爆上下文

---

请确认此方案后，我开始实现 Phase 3。