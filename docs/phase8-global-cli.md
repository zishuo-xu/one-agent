# Phase 8：全局 CLI 命令

> 文档状态：历史阶段快照（非当前 CLI 完整手册）
> 阅读说明：本文记录全局命令首次实现时的行为；当前命令与启动方式以 [根 README](../README.md)为准，分类规则见 [文档索引](./README.md)。

**日期**：2026-07-13  
**项目**：one-agent  
**状态**：✅ 已实现

---

## 目标

让用户安装 CLI 后，在任意终端输入 `one-agent` 就能启动 REPL，无需进入仓库目录或手动配置路径。

```bash
# 全局安装后
one-agent

# 指定工作目录
one-agent --workspace ~/my-agent

# 或通过环境变量
ONE_AGENT_WORKSPACE=~/my-agent one-agent
```

---

## 技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 工作目录解析 | `--workspace` > `ONE_AGENT_WORKSPACE` > 当前目录（含 `.env`）> 仓库源码（dev 回退）> `~/.one-agent` | 全局安装时默认用户目录，开发时仍可用仓库目录 |
| `.env` 加载 | 从工作目录加载 | 与 workspace 绑定，全局安装自然可用 |
| 数据文件 | `<workspace>/data.db` | 保留现有 SQLite 文件结构 |
| 可执行文件 | `dist/index.js` 加 shebang + 可执行权限 | `package.json` bin 字段已指向该文件 |
| 发布 | 代码结构 ready；支持 `pnpm link --global` 本地测试 | 学习项目可暂不发布 npm，但已非 private |

---

## 改造点

### 1. 工作目录解析模块

`apps/cli/src/workspace.ts`：

```ts
export function resolveWorkspaceRoot(options?: { ... }): string
```

解析优先级：

1. `--workspace` 参数
2. `ONE_AGENT_WORKSPACE` 环境变量
3. 当前目录（如果存在 `.env`）
4. `~/.one-agent` 默认目录

注意：从仓库根目录运行 `one-agent` 时，由于当前目录存在 `.env`，会继续使用仓库根目录作为 workspace；从其他目录运行时则默认使用 `~/.one-agent`。


### 2. 环境加载

`apps/cli/src/load-env.ts`：

- 调用 `resolveWorkspaceRoot()`
- 自动创建工作目录
- 从工作目录加载 `.env`

### 3. CLI 入口

`apps/cli/src/index.ts`：

- 从 `load-env.js` 导入 `WORKSPACE_ROOT`
- 使用 `WORKSPACE_ROOT` 创建 Sandbox
- 默认数据库路径：`path.join(WORKSPACE_ROOT, 'data.db')`

### 4. 构建脚本

`apps/cli/package.json`：

```json
{
  "build": "tsc -b && node -e \"... add shebang ...\" && chmod +x dist/index.js"
}
```

确保 `dist/index.js` 可直接作为可执行文件运行。

---

## 使用方式

### 本地开发

```bash
pnpm install
pnpm dev:cli
```

### 全局安装（本地测试）

```bash
pnpm build
cd apps/cli
pnpm link --global
one-agent
```

首次运行会在 `~/.one-agent` 创建目录。你需要把 API key 放入 `~/.one-agent/.env`：

```bash
cp ../../.env.example ~/.one-agent/.env
# 编辑 ~/.one-agent/.env，填入 OPENAI_API_KEY
```

### 指定工作目录

```bash
one-agent --workspace ~/workspace/agent-demo
```

---

## 文件结构

```text
~/.one-agent/
├── .env          # API key 等配置
├── data.db       # SQLite 持久化数据
└── workspace/    # 工具操作的文件目录（未来可选）
```

---

## 测试

`apps/cli/tests/workspace-resolution.test.ts` 覆盖解析优先级。

---

## 相关文档

- `README.md`
- `docs/optimization-notes.md`
- `SIMPLIFIED_AGENT_PROJECT_ROADMAP.md`
