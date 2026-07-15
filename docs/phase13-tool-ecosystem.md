# Phase 13：工具生态扩展（Shell 执行 + 文件工具补齐）

**日期**：2026-07-13
**状态**：✅ 已完成

---

## 目标

让 Agent 从"能聊天"变成"能干活"：新增 `run_command` Shell 执行工具，补齐文件工具
`append_file` / `delete_file` / `search_files`，并提供 `DISABLED_TOOLS` 环境变量
供 API 部署时禁用危险工具。

## 信任模型（重要）

工具在发起 Agent 的用户权限下执行**任意命令**。本项目实现的防护是**基本护栏**，
**不是安全边界**：

| 防护层 | 作用 | 局限 |
|---|---|---|
| cwd 限定 workspace 根 | 命令默认在工作区执行 | `cd ..` 或绝对路径可离开 |
| 危险命令 blocklist | 拦截明显危险的命令模式 | 正则匹配可被构造绕过 |
| 超时 | 默认 30s，上限 120s | — |
| 输出截断 | 每流 10000 字符 | 保护上下文窗口，非安全机制 |

面向**本地 / 学习场景**设计。**对外暴露 API 时必须禁用**：

```bash
DISABLED_TOOLS=run_command,delete_file pnpm dev:api
```

## 工具清单

### `run_command`（shellExec.ts）

在 workspace 根目录用 `/bin/sh` 执行命令。

- **非零退出码是正常结果**：返回 `{ exitCode, stdout, stderr, truncated, durationMs }`，
  让模型看到测试失败、编译错误等真实输出并自我纠正
- **超时**（`error.killed`）才是工具失败
- **blocklist**（`BLOCKED_PATTERNS`）：`rm -rf /|~`、`sudo`、`mkfs/fdisk`、`dd of=/dev/`、
  `shutdown/reboot/halt/poweroff`、`curl|wget ... | sh`、fork bomb、`kill -9 -1`

### `append_file`
追加文本（不存在则创建），复用 `sandbox.isTextFile` 扩展名白名单。

### `delete_file`
删除 workspace 内文件。拒删目录、拒路径穿越。删除即生效——风险等级与已有
`write_file` 覆盖写同级（交互式确认机制留作后续增强）。

### `search_files`
- `pattern`：`*` `?` 通配符匹配 workspace 相对路径
- `contentPattern?`：内容子串匹配（仅文本文件），返回匹配行号
- 跳过 `node_modules` / `.git` / `dist`；默认上限 50 条

## DISABLED_TOOLS

`createBuiltInTools` 读取 `DISABLED_TOOLS`（逗号分隔工具名）过滤注册结果，
CLI / API / eval 四处自动生效。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/tools/built-in/{shellExec,appendFile,deleteFile,searchFiles}.ts` | 新增 4 个工具 |
| `src/tools/built-in/index.ts` | DISABLED_TOOLS 过滤 + 具名导出新工具 |
| `tests/tools/{shell-exec,file-tools-extended}.test.ts` | 新增 19 个测试 |
| `tests/tools/built-in-tools.test.ts` | 列表断言 + 过滤用例 |

## 验证

- 全套 223 个测试通过（含 19 个新增 + 3 个更新）
- 真实 DeepSeek：Agent 自主调用 `run_command` 执行 `ls` / `cat` 验证文件
