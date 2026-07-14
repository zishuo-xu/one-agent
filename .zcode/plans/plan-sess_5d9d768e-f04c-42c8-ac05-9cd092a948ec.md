# 上下文管理增强：Token 计数压缩

## 目标
将上下文压缩从"按消息数量"改为"按 token 估算"，避免长对话超出模型上下文窗口。不引入外部 tokenizer 依赖，使用轻量启发式估算。

---

## 第一阶段：Token 估算工具

### 新增 `packages/agent-core/src/context/tokenEstimate.ts`

```ts
export function estimateTokens(text: string): number
```

启发式策略（无需外部依赖，对中英文混合文本合理近似）：
- CJK 字符（中日韩）：约 1 token/字
- ASCII 字符：约 4 字符/token
- 其他：约 2 字符/token
- 空消息（role 等）：每条消息额外 ~4 token 开销

```ts
export function estimateMessageTokens(message: Message): number
```
对单条 Message 估算 token（content + tool_calls + role 开销）。

---

## 第二阶段：ContextManager 改造

### 新增配置 `packages/agent-core/src/config.ts`

```ts
maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS ?? '4096'),
recentTokenBudget: Number(process.env.RECENT_TOKEN_BUDGET ?? '2048'),
```

### `ContextManagerOptions` 扩展

```ts
export interface ContextManagerOptions {
  systemPrompt: string;
  maxRecentMessages?: number;   // 保留作为后备（向后兼容）
  summaryTrigger?: number;      // 保留作为后备
  maxContextTokens?: number;    // 新：上下文总 token 预算
  recentTokenBudget?: number;   // 新：保留的最近消息 token 预算
}
```

### `buildContext()` 重写 `packages/agent-core/src/context/ContextManager.ts`

新逻辑（token 优先，消息数后备）：
1. 估算所有消息的总 token 数
2. 如果 totalTokens <= maxContextTokens，直接返回全部（不压缩）
3. 如果 totalTokens > maxContextTokens：
   - 从最新消息向前累积，直到达到 recentTokenBudget，确定 recentStart
   - 如果 lastSummarizedIndex < recentStart，对 [lastSummarizedIndex, recentStart) 的消息做摘要
   - 返回 system + memory + summary + recent 消息
4. 向后兼容：如果 maxContextTokens 未设置（undefined），回退到原有消息数逻辑

### 修复 `summarize()` 超时

`{ timeout: 30000 }` 改为 `{ timeout: config.timeoutMs }`。

### `getContextForDisplay()` 增强

新增方法返回 token 估算信息，供 CLI `/context` 命令显示。

---

## 第三阶段：AgentLoop + CLI 接入

### `AgentLoopOptions` 透传

`AgentLoopOptions` 新增 `maxContextTokens?` 和 `recentTokenBudget?`，构造 ContextManager/PersistenceContextManager 时透传。

### CLI `/context` 命令增强 `apps/cli/src/index.ts`

`/context` 输出新增：
- 当前上下文估算 token 数
- token 预算（maxContextTokens）
- 是否已触发摘要

---

## 第四阶段：测试 + 文档

### 测试 `packages/agent-core/tests/context/`

- 新增 `tokenEstimate.test.ts`：测试 estimateTokens 和 estimateMessageTokens 的基本正确性
- 更新 `ContextManager.test.ts`：新增 token 触发压缩的测试（设置 maxContextTokens，添加大量文本，验证压缩触发）

### 文档

- 更新 `docs/optimization-notes.md` Phase 3 条目
- `--init` 模板新增 `MAX_CONTEXT_TOKENS` 和 `RECENT_TOKEN_BUDGET` 配置项说明

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/agent-core/src/context/tokenEstimate.ts` | 新增 token 估算工具 |
| `packages/agent-core/src/context/ContextManager.ts` | token 压缩逻辑 + 配置 |
| `packages/agent-core/src/config.ts` | 新增 maxContextTokens/recentTokenBudget |
| `packages/agent-core/src/agents/AgentLoop.ts` | 透传 token 配置 |
| `apps/cli/src/index.ts` | /context 显示 token 估算 |
| `packages/agent-core/tests/context/tokenEstimate.test.ts` | 新增 |
| `packages/agent-core/tests/context/ContextManager.test.ts` | 新增 token 压缩测试 |
| `docs/optimization-notes.md` | 更新 Phase 3 状态 |

## 验证标准

- `pnpm build` 通过
- `pnpm test` 全绿（含新测试）
- 向后兼容：不设置 maxContextTokens 时行为不变
- 设置 maxContextTokens 后，长文本对话触发压缩
- `/context` 显示 token 估算
