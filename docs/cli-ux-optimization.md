# CLI 可理解性、响应感与可操作性优化

**日期**：2026-07-14
**范围**：`apps/cli`、`packages/agent-core`（config/AgentLoop 超时配置）
**目标**：在不扩展 Agent 能力的前提下，提升 CLI 的可理解性、响应感与可操作性。

---

## 一、P0：交互反馈与异常可诊断

### 1. 启动页精简 + `/help`

**改动**：
- 启动首屏仅输出两行：会话短 ID + 操作提示。
- 交互中新增 `/help`，展示所有 REPL 命令和启动参数（含 `--workspace`、`--new`）。
- 启动时区分"已创建会话"与"已恢复会话"：`printStartup(threadId, mode)`。
- 无参数启动默认恢复最近会话；显式 `--new`（或 `--new-thread`）才新建。

**验收**：
- 启动首屏不超过 3 行。
- `/help` 中的命令与实际实现一致。
- `--thread <id>` 恢复已存在会话时显示"已恢复会话"。

**相关文件**：
- `apps/cli/src/help.ts`
- `apps/cli/src/args.ts`（`resolveThread`）
- `apps/cli/src/index.ts`

---

### 2. 请求状态和耗时拆分

**改动**：
- 请求开始时进度指示器显示 `正在请求 glm-5.2…`（跟随 `config.model`）。
- 首个文本到达后记录 **首字耗时**（TTFA）。
- 结束显示拆分为：`(首字 1.2s · 回答 6.8s · 工具 0.4s · 记忆：后台提取已启动)`。
- 工具调用阶段记录工具阶段耗时。
- 通过 `AgentLoop` 的 `awaitMemoryExtraction: false` 让记忆提取在后台执行，不阻塞下一次输入。
- 记忆状态仅 `--verbose` 显示；未配置记忆时显示"记忆：未配置"，避免误导。

**验收**：
- 普通对话能区分首字耗时和完整回答耗时。
- 后台记忆慢不会阻塞下一次输入。
- 工具调用时显示工具阶段耗时。

**相关文件**：
- `apps/cli/src/chat-events.ts`（事件处理工厂）
- `apps/cli/src/index.ts`

---

### 3. 错误提示可操作

**改动**：
- 新增 `apps/cli/src/errors.ts`，对常见错误分类：
  - 网络/超时：提示在 `.env` 中增大 `OPENAI_TIMEOUT_MS`（当前默认 30000ms）。
  - 401/403：提示检查 `OPENAI_API_KEY`。
  - 404：提示检查 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`。
  - 429：提示限流并给出建议等待时间。
  - 模型空回复：保留 `runId`，提示执行 `/runs`、`/traces <run-id>`。
- 普通模式只输出简洁说明；`--verbose` 保留完整原始错误。
- **`OPENAI_TIMEOUT_MS` 真正生效**：`config.timeoutMs` 读取该环境变量，`AgentLoop` 默认从 `config.timeoutMs` 取值，而非之前写死的 30 秒。

**验收**：
- 常见错误不需要阅读源码即可定位配置方向。
- 设置 `OPENAI_TIMEOUT_MS=60000` 后 AgentLoop 使用 60 秒超时。

**相关文件**：
- `apps/cli/src/errors.ts`
- `packages/agent-core/src/config.ts`
- `packages/agent-core/src/agents/AgentLoop.ts`

---

## 二、P1：回答和记录可读性

### 4. 基础 Markdown 终端渲染 + 实时流式输出

**改动**：
- 新增 `apps/cli/src/markdown.ts`，手动实现轻量 Markdown 渲染：
  - 标题（`#` / `##` / `###`）加粗。
  - 无序列表（`-` / `*`）和有序列表（`1.`）缩进渲染。
  - 粗体 `**text**` 加粗。
  - 行内代码 `` `code` `` 和代码块（` ``` `）带边界色。
  - 代码块保留原始缩进，可直接复制。
  - 不支持的 Markdown 降级为原始文本，不报错。
- 支持 `NO_COLOR=1` 关闭颜色。无外部依赖。
- **流式输恢复为逐 token 打印**：`message_delta` 事件到达即通过 `process.stdout.write` 打印，首字时间真正反映用户看到首个字符的时刻；Markdown 渲染仅在非流式回答上结束后应用，不会阻塞正文。

**验收**：
- 慢回答时用户能立刻看到文字逐步出现，而非空白终端。
- 非流式回答（例如工具后直接给出结果）仍进行 Markdown 渲染。
- `NO_COLOR=1` 时无 ANSI 颜色。

**相关文件**：
- `apps/cli/src/markdown.ts`
- `apps/cli/src/chat-events.ts`
- `apps/cli/src/format.ts`

---

### 5. `/runs` 和 `/traces` 摘要化

**改动**：
- `/runs` 显示短 ID、状态、耗时、标题：
  ```text
  8e0208da  completed  6.8s    你能做什么
  ```
- `/traces` 默认显示当前最近 run 的最近 20 条 trace。
- 支持 `/traces <run-id>` 和 `/traces <run-id> --verbose`。
- 支持 `/runs <run-id>` 查看该 run 详情并列出其 trace。
- 普通 trace 展示事件类型、时间、简短摘要；完整 JSON 仅在 `--verbose` 展示。
- UUID 可输入短 ID 前 8 位进行匹配。

**验收**：
- 不需要复制完整 UUID 也能定位最近 run。
- 大量 trace 不会一次性淹没终端。

**相关文件**：
- `apps/cli/src/commands/traces.ts`
- `apps/cli/src/index.ts`

---

### 6. 会话标题与列表优化

**改动**：
- `/threads` 显示短 ID、标题、相对时间：
  ```text
  * 8e0208da  你能做什么                  2 分钟前
    f06e447d  帮我总结 README              昨天
  ```
- 当前会话带 `*` 标记。
- 标题缺失时显示首条用户消息摘要，而非 `(no title)`。
- 时间显示为相对时间（刚刚 / 3 分钟前 / 昨天）。

**相关文件**：
- `apps/cli/src/index.ts`
- `apps/cli/src/format.ts`

---

## 三、辅助文件

- `apps/cli/src/format.ts`：短 ID、时长、相对时间、颜色工具（`supportsColor` 为 boolean）。
- `apps/cli/src/help.ts`：启动提示、帮助文本、`--help` 输出。
- `apps/cli/src/errors.ts`：错误分类和可操作提示。
- `apps/cli/src/markdown.ts`：轻量 Markdown 渲染。
- `apps/cli/src/chat-events.ts`：事件处理工厂，捕获计时并驱动进度/流式打印。
- `apps/cli/src/args.ts`：参数解析、API key 检查、`resolveThread` 纯函数。
- `apps/cli/src/output.ts`：终端文本清理（保留）。

---

## 四、测试

新增针对以下内容的单测：

- `tests/help-errors-markdown.test.ts`：启动文案（创建/恢复）、`--workspace`/`--new` 文档说明、错误分类（超时/401/404/429/runId 提示）、Markdown 渲染、格式化辅助。
- `tests/resolve-thread.test.ts`：`resolveThread` 各分支（恢复已存在、创建不存在、`--new`、默认恢复最近、`--new` 别名）。
- `tests/chat-events.test.ts`：实时 token 流式输出、进度停止、首字时间、空白 delta 过滤、`verbose` 控制 thought 显示、tool_call/tool_result 通过 onInfo 输出。

CLI 测试从 20 个增长到 57 个。

---

## 五、验证结果

- `pnpm build` 通过。
- `pnpm test` 全部通过：
  - `agent-core`: 31 文件 / 160 测试
  - `api`: 4 文件 / 27 测试
  - `cli`: 8 文件 / 57 测试
  - `trace-web`: 1 文件 / 7 测试