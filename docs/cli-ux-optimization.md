# CLI 可理解性、响应感与可操作性优化

**日期**：2026-07-14
**范围**：`apps/cli`
**目标**：在不扩展 Agent 能力的前提下，提升 CLI 的可理解性、响应感与可操作性。

---

## 一、P0：交互反馈与异常可诊断

### 1. 启动页精简 + `/help`

**改动**：
- 启动首屏仅输出两行：会话短 ID + 操作提示。
- 交互中新增 `/help`，展示所有 REPL 命令和启动参数。
- `--help` 继续用于非交互模式启动。

**验收**：
- 启动首屏不超过 3 行。
- `/help` 中的命令与实际实现一致。

**相关文件**：
- `apps/cli/src/help.ts`
- `apps/cli/src/index.ts`

---

### 2. 请求状态和耗时拆分

**改动**：
- 请求开始时进度指示器显示 `正在请求 glm-5.2…`（跟随 `config.model`）。
- 首个文本到达后记录 **首字耗时**（TTFA）。
- 结束显示拆分为：`(首字 1.2s · 回答 6.8s · 工具 0.4s · 记忆后台处理中)`。
- 工具调用阶段记录工具阶段耗时。
- 通过 `AgentLoop` 的 `awaitMemoryExtraction: false` 让记忆提取在后台执行，不阻塞下一次输入。

**验收**：
- 普通对话能区分首字耗时和完整回答耗时。
- 后台记忆慢不会阻塞下一次输入。
- 工具调用时显示工具阶段耗时。

**相关文件**：
- `apps/cli/src/index.ts`

---

### 3. 错误提示可操作

**改动**：
- 新增 `apps/cli/src/errors.ts`，对常见错误分类：
  - 网络/超时：提示检查网络并给出超时配置方向。
  - 401/403：提示检查 API key。
  - 404：提示检查 `OPENAI_BASE_URL` 和模型名。
  - 429：提示限流并给出建议等待时间。
  - 模型空回复：保留 `runId`，提示执行 `/runs`、`/traces <run-id>`。
- 普通模式只输出简洁说明；`--verbose` 保留完整原始错误。

**验收**：
- 常见错误不需要阅读源码即可定位配置方向。
- 原始错误保留在 `--verbose` 或 trace 中。

**相关文件**：
- `apps/cli/src/errors.ts`
- `apps/cli/src/index.ts`

---

## 二、P1：回答和记录可读性

### 4. 基础 Markdown 终端渲染

**改动**：
- 新增 `apps/cli/src/markdown.ts`，手动实现轻量 Markdown 渲染：
  - 标题（`#` / `##` / `###`）加粗。
  - 无序列表（`-` / `*`）和有序列表（`1.`）缩进渲染。
  - 粗体 `**text**` 加粗。
  - 行内代码 `` `code` `` 和代码块（` ``` `）带边界色。
  - 代码块保留原始缩进，可直接复制。
  - 不支持的 Markdown 降级为原始文本，不报错。
- 支持 `NO_COLOR=1` 关闭颜色。
- 没有引入外部依赖，避免增加项目复杂度。

**验收**：
- 列表层级清晰，代码块可直复制。
- `NO_COLOR=1` 时无 ANSI 颜色。

**相关文件**：
- `apps/cli/src/markdown.ts`
- `apps/cli/src/format.ts`
- `apps/cli/src/index.ts`

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
- 仍可查看完整事件数据。

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

**验收**：
- 列表对齐、可读。
- 标题缺失时有合理回退。

**相关文件**：
- `apps/cli/src/index.ts`
- `apps/cli/src/format.ts`

---

## 三、辅助文件

- `apps/cli/src/format.ts`：短 ID、时长、相对时间、颜色工具。
- `apps/cli/src/help.ts`：启动提示、帮助文本、`--help` 输出。
- `apps/cli/src/errors.ts`：错误分类和可操作提示。
- `apps/cli/src/markdown.ts`：轻量 Markdown 渲染。
- `apps/cli/src/output.ts`：终端文本清理（保留）。
- `apps/cli/src/args.ts`：参数解析和 API key 检查（保留）。

---

## 四、验证结果

- `pnpm build` 通过。
- `pnpm test` 全部通过：
  - `agent-core`: 31 文件 / 160 测试
  - `api`: 4 文件 / 27 测试
  - `cli`: 5 文件 / 20 测试
  - `trace-web`: 1 文件 / 7 测试

---

## 五、待后续观察

1. Markdown 渲染当前在完整回答返回后统一渲染，放弃了流式逐字打印。若后续对长回答的流式体验有更高要求，可考虑增量渲染或流式+事后重排。
2. 工具阶段耗时目前只在首个 tool_call 到最后一个 tool_result 之间计算；多轮工具调用的细分耗时可在后续继续优化。
3. 错误分类基于错误消息关键字匹配，后续可结合 HTTP 状态码做更精确判断。
