# CLI 交互体验改进

**日期**：2026-07-13  
**目标**：修复实测发现的启动、响应、中断、历史展示和命令提示等交互问题。

---

## 一、修复的问题

### 1. 默认启动即失败（已修复）

**问题**：在指定目录直接执行 `one-agent` 时，若未配置 `OPENAI_API_KEY` 会立即报错退出，连 `--help`、`--version` 也无法使用。

**修复**：
- 将 API key 检查后置到 `--help` / `--version` 处理之后。
- 新增 `--help` / `-h` 和 `--version` 参数，无需 key 即可查看帮助和版本。
- 新增 `--init` 参数，在当前 workspace 创建 `.env` 模板文件。
- 未配置 key 时给出友好引导：提示运行 `one-agent --init` 或手动创建 `.env`。

### 2. 响应等待过长且无反馈（已修复）

**问题**：普通问候持续约 30 秒才返回，只显示循环 `Thinking...`，没有阶段、耗时等信息。

**修复**：
- 进度指示器根据当前事件切换阶段标签：
  - `Planning` → 生成计划
  - `Working` → 执行工具 / 思考
  - `Re-planning` → 触发反思后重规划
  - `Answering` → 输出最终回答
- 响应结束后显示本次耗时（毫秒）。
- 非 verbose 模式下隐藏内部 thought / plan / reflection，只显示工具调用摘要和最终回答。

### 3. Ctrl-C 不能及时中断（已修复）

**问题**：输入后触发工具调用并长时间无输出，单次 Ctrl-C 无效，需要连续按两次才退出。

**修复**：
- `AgentLoop.chat` 支持传入 `AbortSignal`。
- `AgentLoop` 的 `callModel` / `streamModel` 将 `signal` 透传给 OpenAI SDK，模型调用可被中断。
- CLI 中每次用户输入后创建 `AbortController`，单次 Ctrl-C 发送 abort 信号并提示 "Interrupting current turn..."，连续两次 Ctrl-C 才强制退出。
- 中断后显示 `Turn cancelled.`，而不是抛出未处理错误。

### 4. /history 暴露内部执行内容（已修复）

**问题**：`/history` 中出现了内部计划、执行步骤和提示词，例如 `Execute the following step from the plan`、`Think step by step`。

**修复**：
- 在 `Message` 类型中新增 `internal?: boolean` 字段。
- `AgentLoop` 在所有内部消息（step prompt、thought、tool_calls、tool result、finalize prompt）上标记 `internal: true`。
- 新增 `AgentLoop.getUserFacingHistory()`，只返回非 internal 的 user / assistant 消息。
- `/history` 使用 `getUserFacingHistory()`，显示为 `You: ...` / `Assistant: ...` 的对话形式。

### 5. /context 也暴露内部提示词（已修复）

**问题**：`/context` 输出与完整历史高度相似，包含 system prompt 和内部执行文本，含义不清晰。

**修复**：
- `/context` 改为显示摘要信息：
  - 当前上下文中的最近消息数量
  - 是否存在对话摘要
  - 是否存在长期记忆注入
  - 最近 4 条非系统消息预览

### 6. /reasoning 内容不符合用户预期（已修复）

**问题**：`/reasoning` 显示的是最终回答内容，而不是可读的推理摘要。

**修复**：
- `/reasoning` 显示推理链摘要：总步数、thought 数、action 数、reflection 数。
- 列出每个推理步骤的 planStepId、thought、action、observation、reflection、failureAnalysis 等关键字段。
- 无推理链时提示 `No reasoning trace for the current turn.`。

### 7. 命令提示不够一致（已修复）

**问题**：启动提示包含 `/traces`，但用户不易知道用途；`/thread` 缺少参数时只提示 `Unknown command`。

**修复**：
- 启动时打印更详细的命令说明，每条命令带用途解释。
- `/thread` 无参数时显示 `Usage: /thread <id>` 并提示使用 `/threads` 查看可用线程。
- 未知命令提示中追加 `Run "one-agent --help" for details.`。

---

## 二、改动文件

- `packages/agent-core/src/agents/types.ts`：新增 `Message.internal` 字段。
- `packages/agent-core/src/agents/AgentLoop.ts`：
  - 标记内部消息
  - `chat` 支持 `AbortSignal` 参数
  - `callModel` / `streamModel` 透传 `signal`
  - 新增 `getUserFacingHistory()`
- `apps/cli/src/index.ts`：
  - `--help` / `--version` / `--init` 支持
  - 后置 API key 检查与友好引导
  - 阶段化进度指示器 + 耗时显示
  - Ctrl-C 中断处理
  - `/history` / `/context` / `/reasoning` 改进
  - 命令提示改进

---

## 三、验证结果

- `pnpm build` 通过
- `pnpm test` 全部通过：
  - `agent-core`: 31 个测试文件，156 个测试
  - `api`: 4 个测试文件，27 个测试
  - `cli`: 3 个测试文件，12 个测试
  - `trace-web`: 1 个测试文件，7 个测试

---

## 四、提交信息

```text
feat(cli): improve interaction flow with help, abort, progress, and user-facing commands
```
