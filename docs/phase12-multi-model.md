# Phase 12：多模型抽象层

> 文档状态：历史阶段快照（非当前模型配置完整手册）
> 阅读说明：本文保留 ModelProvider 首次落地时的设计和测试数据。当前配置入口见 [根 README](../README.md)，能力边界见 [项目现状](./project-vision-and-status.md)。

**日期**：2026-07-13
**状态**：✅ 已完成

---

## 目标

把散落在 5 个文件中的 8 个裸 `config.openai.chat.completions.create` 调用收敛到 `ModelProvider` 接口后面：

- 统一 OpenAI 兼容端点（OpenAI / DeepSeek / Qwen / Kimi / GLM / Ollama）的调用差异
- 模型特定逻辑（reasoning_content 分离、usage 提取、jsonMode 降级）收拢到 provider 层
- `FallbackProvider` 主备自动切换（env 配置备用模型）
- 现有测试与 eval mock 机制零改动

## 架构

```text
AgentLoop / Planner / TaskJudge / MemoryExtractor / ContextManager
        │
        ▼  ModelRequest / ModelResponse / ModelChunk（归一化类型）
   ModelProvider（接口）
        ├─ OpenAICompatibleProvider ── OpenAI SDK client ── 任意兼容端点
        └─ FallbackProvider ── [primary, fallback, ...]
```

### 归一化接口（`src/model/types.ts`）

- `complete(request) → ModelResponse`：`content` / `reasoning` / `toolCalls` / `usage`
- `stream(request) → AsyncIterable<ModelChunk>`：`content` / `reasoning` / `toolCallDeltas` / `usage`
- `jsonMode: true` 时 provider 先试 `response_format: json_object`，端点不支持则自动降级为普通调用（此逻辑原在 Planner，上移后 TaskJudge 自动受益）

### OpenAICompatibleProvider 收拢的 wire 格式知识

- `reasoning_content` 多层探测（delta / delta.message / choices[0].message 三个嵌套层级，snake_case + camelCase）
- 流式 tool_calls 分片按 `index` 透出
- `stream_options: { include_usage: true }` 的 usage 提取
- 端点忽略 `stream: true` 直接返回完整响应的 quirk：合成 chunk，调用方无感知

### FallbackProvider 的切换语义

- **complete**：按序尝试，`shouldFallback` 判定可切换错误
- **stream**：只在**首个 chunk 成功前**允许切换——手动拉第一个 chunk，成功即锁定该 provider，后续错误直接抛出（与 AgentLoop 的 emittedDelta 不重试守卫语义一致，已流出的部分输出绝不因切换而重复）
- 默认 `shouldFallback`：5xx / 429 / 无 status（网络错误）→ 切换；`AbortError` 永不切换；其他 4xx 不切换（同样的请求换个端点也会失败）

## 兼容性关键决策

现有 mock 机制都作用于 `config.openai`：

- 13 个测试文件 `vi.mock('../../src/config.js')`（mock 对象里没有 `modelProvider` 字段）
- eval monkey-patch `config.openai.chat.completions.create`

因此采用**三级 provider 解析**：

```typescript
options.modelProvider ?? config.modelProvider ?? new OpenAICompatibleProvider(config.openai, config.model)
```

- 测试中：`config.modelProvider` 为 undefined → 惰性包装 mock 的 `config.openai` → vi.fn() 正常被调用
- eval 中：provider 持有 `config.openai` 引用并按调用时动态查找方法 → monkey-patch 生效
- 生产中：用 `config.modelProvider`（含 fallback 链）

**eval 锚定**：`EvalRunner` 构造 AgentLoop 时显式传主 provider，防止配置了 fallback 后 "Mock model exhausted" 错误触发静默切换、破坏 mock 确定性。

## 配置

```bash
# 主模型（原有）
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=sk-...
OPENAI_MODEL=deepseek-v4-flash

# 备用模型（新增，可选）：主模型出现可切换错误时自动 failover
OPENAI_FALLBACK_BASE_URL=https://api.openai.com/v1
OPENAI_FALLBACK_API_KEY=sk-...
OPENAI_FALLBACK_MODEL=gpt-4o-mini
```

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/model/{types,OpenAICompatibleProvider,FallbackProvider,factory,index}.ts` | 新增 |
| `src/config.ts` | +`modelProvider` |
| `src/agents/AgentLoop.ts` | 3 个模型方法重构，删除 ~100 行 wire 格式探测代码 |
| `src/planning/{Planner,TaskJudge}.ts` | 换用 provider；Planner 删除本地 jsonMode fallback |
| `src/memory/MemoryExtractor.ts` | 换用 provider |
| `src/context/ContextManager.ts` | summarize 换用 provider |
| `src/eval/runner.ts` | 显式锚定主 provider |
| `tests/model/*.test.ts` | 新增 18 个测试 |

## 验证

- 全套 299 个测试通过（281 原有 + 18 新增），零测试改动
- eval mock 模式 21 个场景确定性不受影响
- 真实 DeepSeek 调用：流式 + reasoning 分离 + token usage 正常
- 真实工具调用：read_file 端到端正常
- 真实 failover：主端点置为无效地址，自动切换到备用 DeepSeek 并正常回答

## 后续可选方向

- Anthropic 原生 provider（Messages API 格式差异大，需引入 @anthropic-ai/sdk）
- 按调用场景选模型（规划用大模型、摘要用小模型）
- FallbackProvider 健康检查与熔断（连续失败后暂时摘除主端点）
