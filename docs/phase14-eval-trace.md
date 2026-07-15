# Phase 14：Eval + Trace 联动（失败案例可观测闭环）

**日期**：2026-07-15
**状态**：✅ 已完成

---

## 目标

打通评估与观测：**eval 任务失败时，完整 trace 落盘并可在 trace-web 中直接查看失败现场**；
同时把 eval 数据集从代码迁移为独立管理的 JSON 文件。

## 之前的问题

- EvalRunner 构造 AgentLoop 时不传 `threadId` → eval 运行不产生任何持久化 trace，
  失败只能看 CLI 输出的断言错误，无法回放事件流
- 20+2 个 eval 场景硬编码在 TS 文件里，新增/修改场景要改代码

## 设计

### 1. EvalRunner 持久化（`traceDbPath`）

```text
EvalRunnerOptions.traceDbPath = '/path/eval-traces.db'
        │
        ▼ 每个任务
  ThreadStore.create('eval: <name>')  ── 独立 thread
        │
        ▼ AgentLoop(threadId, db)
  run / trace_events / tool_calls 全部自动落盘
        │
        ▼ 断言完成后
  失败 → runStore.fail(runId, 断言错误) + 标题 '[FAIL] eval: <name>'
  通过 → 标题 '[PASS] eval: <name>'
```

不传 `traceDbPath` 时行为与之前完全一致（现有测试零影响）。

### 2. JSON 数据集（`packages/agent-core/eval-datasets/`）

```text
eval-datasets/
├── mock/          # 19 个确定性回放场景（含 mockResponses）
│   ├── tool-chain.json
│   └── ...
└── real/          # 2 个真实模型 benchmark
    ├── real-model-planning.json     # 同时属于 mock 与 real 两组
    └── real-model-benchmark.json
```

- `datasetLoader.ts`：`loadEvalDataset(dir)` 递归读取 + zod 校验（错误带文件路径）
  + 重复 id 检测；`resolveBundledDatasetDir()` 从模块位置向上查找数据集目录
  （兼容 src/tsx 与 dist 两种布局）
- `scenarios/index.ts` 变为薄壳：保持全部 20 个具名导出 + 3 个数组不变，
  所有现有消费者（scenarios.test.ts、CLI、agent-core index）零改动

### 3. CLI eval 新参数

```bash
pnpm --filter cli eval                          # 内置 mock 数据集
pnpm --filter cli eval -- --real                # 内置真实模型数据集
pnpm --filter cli eval -- --dataset /path/dir   # 外部 JSON 数据集
pnpm --filter cli eval -- --trace               # 持久化 trace（默认 ./eval-traces.db）
pnpm --filter cli eval -- --trace --db /tmp/t.db
```

失败任务输出附 `trace: thread <id>`，结尾打印查看命令。

### 4. trace-web 失败现场

- runs 列表：失败 run 红色左边框 + 错误摘要（hover 看全文）
- 查看：`DATABASE_PATH=<eval-db> pnpm dev:trace-web`，线程列表中 `[FAIL]` 前缀一目了然

## 改动清单

| 文件 | 改动 |
|---|---|
| `eval-datasets/mock/*.json` ×19 `real/*.json` ×2 | 新增（TS → JSON 机械迁移） |
| `src/eval/datasetLoader.ts` | 新增加载器 + zod schema |
| `src/eval/scenarios/index.ts` | 薄壳重写（导出面不变） |
| `src/eval/scenarios/*.ts` ×21 | 删除 |
| `src/eval/runner.ts` `types.ts` | traceDbPath 持久化 + 结果标记 |
| `apps/cli/src/eval.ts` | --trace/--db/--dataset |
| `apps/trace-web/src/server.ts` | 失败 run 样式 + error 摘要 |
| `tests/eval/{trace-persistence,dataset-loader}.test.ts` | 新增 9 个测试 |

## 验证

- 全套 232 个 agent-core 测试通过（scenarios.test.ts 21 个用例零改动 → JSON 迁移等价性）
- `pnpm --filter cli eval`：20/20 通过，输出格式不变
- `--trace`：20 个 thread 全部 `[PASS]` 标题、98 条 trace 事件、26 条 tool_calls 落盘
- 故意失败数据集：run 标记 failed + 断言错误写入 error + 标题 `[FAIL]`
- trace-web API 实测：`/api/threads` 返回 `[FAIL]` 标题，`/api/threads/:id/runs` 返回
  `status: failed` + error 详情

## 后续可选方向

- 失败案例集管理：把失败 trace 归档为回归数据集（自动加入下次 eval）
- 人工复核工作流：trace-web 中对失败 run 标注"已确认/误报"
- CI 集成：eval 失败时上传 trace db 为构建产物
