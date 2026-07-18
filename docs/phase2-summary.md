# One Agent 项目 — 第二阶段总结报告

> 文档状态：历史阶段快照（非当前实现说明）
> 阅读说明：测试数量、文件结构和“下一步”只代表 Phase 2 完成时。最新事实见 [项目现状](./project-vision-and-status.md)，分类规则见 [文档索引](./README.md)。

**版本**：Phase 2 — Tool Calling  
**日期**：2026-07-13  
**技术栈**：TypeScript + pnpm + zod + OpenAI-compatible SDK

---

## 一、阶段目标

实现 **Tool Calling（工具调用）**：让 Agent 能根据用户问题自动判断是否需要调用工具，并使用工具结果生成最终回答。

```text
用户问题 → Agent 判断 → 执行工具 → 返回工具结果 → 最终回答
```

---

## 二、实现内容

### 2.1 可扩展的工具接口

在 `packages/agent-core/src/tools/` 下建立了完整的工具调用基础设施：

| 模块 | 文件 | 职责 |
|------|------|------|
| 类型定义 | `types.ts` | `ToolDefinition`、`ToolCall`、`ToolResult`、`ToolSchema` |
| 工具注册表 | `registry.ts` | 注册工具、生成 OpenAI-compatible function schema |
| 工具执行器 | `executor.ts` | 参数校验、执行工具、捕获异常 |
| schema 转换 | `zod-to-json-schema.ts` | 将 zod schema 转为 JSON Schema |
| 沙箱 | `sandbox.ts` | 限制文件操作在 `workspace/` 目录内，防止路径穿越 |

**设计亮点**：新工具只需实现 `ToolDefinition` 并注册到 `ToolRegistry` 即可工作，为后续扩展（天气、搜索、外部 API）预留了清晰接口。

### 2.2 本地文件工具

实现 3 个内置文件操作工具：

| 工具 | 功能 | 安全限制 |
|------|------|----------|
| `read_file` | 读取文本文件内容 | 只能读取文本文件（.txt, .md, .json, .ts 等） |
| `write_file` | 写入/覆盖文本文件 | 自动创建父目录，仅允许文本文件 |
| `list_files` | 列出目录内容 | 不能超出 `workspace/` 沙箱 |

沙箱路径解析：
- 所有路径相对 `workspace/` 根目录
- 禁止 `../` 路径穿越
- 自动创建不存在的沙箱目录

### 2.3 AgentLoop 升级

`packages/agent-core/src/agents/AgentLoop.ts` 升级支持 tool calling：

- 构造时接受 `tools: ToolRegistry`
- 将工具 schema 传给模型
- 解析模型返回的 `tool_calls`
- 执行工具并将结果再次传给模型
- 限制最大工具循环次数（默认 5 次）
- 记录 `tool_call` / `tool_result` / `message` 事件
- 保留模型调用重试机制

### 2.4 CLI 集成

`apps/cli/src/index.ts` 注册内置工具并展示调用过程：

```text
🤖 One Agent CLI
Model: glm-5.2
Tools: read_file, write_file, list_files
Workspace: /Users/.../one-agent/workspace

You: 请帮我读取 notes.txt 的内容
[调用工具] read_file: {"path":"notes.txt"}
[工具结果] {"success":true,"data":{"content":"Hello from workspace\n"}}

Agent: 已读取文件内容：Hello from workspace
```

### 2.5 测试覆盖

新增 4 个测试文件，共 25 个测试：

| 测试文件 | 覆盖内容 |
|----------|----------|
| `tests/tools/registry.test.ts` | 工具注册、重复注册、schema 生成 |
| `tests/tools/executor.test.ts` | 正常执行、参数校验、未知工具、执行异常 |
| `tests/tools/sandbox.test.ts` | 路径解析、路径穿越防护、目录创建、文本文件判断 |
| `tests/tools/file-tools.test.ts` | read_file / write_file / list_files 的读写功能 |
| `tests/agent-loop.test.ts` | 普通对话、自定义 prompt、失败重试、tool calling 循环 |

---

## 三、验证结果

```bash
pnpm build
pnpm test
```

结果：

```text
✓ pnpm build：agent-core / api / cli 全部编译通过
✓ pnpm test：27 个测试全部通过
```

CLI 实测：

- 读取文件成功
- 写入文件成功
- 模型能自动修正路径并重新调用工具

---

## 四、项目结构更新

```text
one-agent/
├── apps/
│   ├── api/
│   └── cli/
├── packages/
│   ├── agent-core/
│   │   └── src/
│   │       ├── agents/
│   │       │   └── AgentLoop.ts      # 支持 tool calling
│   │       └── tools/
│   │           ├── types.ts            # 工具类型
│   │           ├── registry.ts         # 工具注册表
│   │           ├── executor.ts         # 工具执行器
│   │           ├── sandbox.ts          # 沙箱路径控制
│   │           ├── zod-to-json-schema.ts
│   │           └── built-in/
│   │               ├── readFile.ts
│   │               ├── writeFile.ts
│   │               ├── listFiles.ts
│   │               └── index.ts
│   └── shared/
├── workspace/                          # Agent 操作沙箱（已 gitignore）
└── docs/
    ├── phase1-summary.md
    ├── phase1-architecture.md
    └── phase2-summary.md
```

---

## 五、Git 提交记录

```text
66dad41 feat: add basic agent loop
f3bba47 chore: ignore generated files and plan metadata
8c36ee4 docs: add README and env example
74fc2a2 refactor: extract agent-core and add CLI REPL
edde385 fix: load .env before agent-core config in CLI/API
7b9e036 feat: add tool registry and built-in file tools
```

---

## 六、后续计划

第三阶段 **Agent Router**：

- 实现 `@researcher` 和 `@coder` 两个 Agent
- 支持显式 `@mention` 路由
- 支持无 mention 时按任务类型自动选择
- 每个 Agent 拥有独立的 system prompt 和可用工具子集

---

## 七、工具扩展说明

新增工具非常简单：

```ts
import { z } from 'zod';
import { ToolDefinition } from './types.js';

const myTool: ToolDefinition = {
  name: 'my_tool',
  description: '...',
  parameters: z.object({ name: z.string() }),
  execute: (args) => {
    return { result: 'ok' };
  },
};

registry.register(myTool);
```

未来可增加 `get_weather`、`search_knowledge`、HTTP 请求、数据库查询等工具，无需修改核心循环。
