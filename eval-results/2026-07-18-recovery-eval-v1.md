# One Agent 真实进程恢复评测 v1

日期：2026-07-18

## 目标

验证断点恢复不只在单元测试构造的 Checkpoint 上成立，而是在 Node 进程被操作系统强制终止后，
仍能依靠 SQLite 中已经持久化的 Run、Checkpoint、Message 和 Trace 安全恢复。

## 方法

评测使用独立 Node 子进程运行真实 `AgentLoop + PlanningLoop`。父测试进程轮询 SQLite，
在目标状态已经持久化后向子进程发送 `SIGKILL`。随后启动第二个 Node 进程，使用同一数据库调用
`resumeRun()`。

这类终止不会执行 `catch/finally`，因此比抛出异常或 AbortSignal 更接近断电、终端关闭和进程崩溃。

运行命令：

```bash
pnpm eval:recovery
```

## 场景与结果

| 场景 | 注入位置 | 预期 | 结果 |
|---|---|---|---|
| 模型调用中断 | Step 已标记 `running`，模型尚未返回 | 旧 Run interrupted；新 Run 完成；记录恢复来源 | PASS |
| 只读工具中断 | `read_file` 已进入 `running` | 补齐孤立 tool-call；安全重试；新 Run 完成 | PASS |
| 写入副作用后中断 | 文件已经写入，`write_file` 尚未返回 | 不重复写入；拒绝自动恢复；标记 recovery_required | PASS |

总计：**3/3 通过**。

## 评测发现

真实中断暴露了一个普通 Checkpoint 单元测试不容易发现的问题：模型发出的 assistant tool-call
已经写入消息历史，但进程可能在 tool result 写入前退出。恢复后，如果直接请求严格模型，历史会因为
tool-call 没有配对结果而被拒绝。

当前修复是在安全重试前先写入一条 `interrupted` 工具结果，闭合旧调用，再由新 Run 重新生成并执行工具。

## 当前边界

- `read_file` 等只读工具允许重复调用，因此评测预期调用次数为两次；
- `write_file` v1 还不会核对文件内容，结果不确定时保守停止；
- 当前未覆盖真实外部 HTTP 副作用、进程启动过程中崩溃、多步骤重规划和三次恢复上限；
- 评测使用确定性模型 Provider，目的是隔离 Runtime 恢复行为，不评估模型智能。
