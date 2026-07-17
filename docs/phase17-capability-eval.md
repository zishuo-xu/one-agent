# Phase 17: 能力评测基础设施（capability eval）

目标：从"回归测试"升级为"能力量化"——测的是 agent（工具链/恢复/规划），不是大模型。
判据：同一模型换个烂架子，分数必须明显掉。本阶段只做前置设施，不跑真实评测。

## 设计要点

- **任务制 + 终态判分**：判分看环境终态（文件是否存在/内容对不对），不看回答文本；
  业界 agent 基准（SWE-bench/AppWorld/τ-bench）的共识做法。
- **任务级 workspace 隔离**：runner 为每个任务建 `workspaceRoot/<taskId>/` 独立目录。
  修复了此前所有任务共享一个 workspaceRoot、文件互相污染的隐患
  （L4 删除题、L6 整理题会留下残骸影响后续任务）。
- **checkpoint 部分给分**：长任务（L6 真实场景档）不再全有全无，
  每个 checkpoint 独立判分、按分值计 earned/points，任务满分才算 passed。
- **能力标签**：`capabilities` + `difficulty` 字段，为按维度/难度聚合分数做准备。

## 新增/扩展的 EvalTask 字段

| 字段 | 语义 |
|---|---|
| `finalAnswerContainsAll` | 全部短语命中（AND，大小写不敏感） |
| `finalAnswerNotContains` | 任何短语不得出现（反向断言，测"不编造/不蛮干"） |
| `expectedFiles[].containsAll / notContains` | 文件内容 AND/反向组合 |
| `forbiddenFiles` | 运行后不得存在的文件（删除验证/越权写入验证） |
| `capabilities` / `difficulty` | 能力维度与难度标签 |
| `checkpoints` | 带权 checkpoint 列表，断言词汇与任务级一致 |

## 改动文件

- `src/eval/types.ts`：EvalTask/EvalFileExpectation/EvalCheckpoint/EvalResult/EvalRunSummary 扩展
- `src/eval/assertions.ts`：`assertFinalAnswerContainsAll` / `assertFinalAnswerNotContains`（纯函数）
- `src/eval/runner.ts`：任务级 workspace 隔离；断言抽取为
  `checkAnswerExpectations` / `checkToolExpectations` / `checkFileExpectations` 三个helper，
  任务级与 checkpoint 级共用；summary 汇总 totalScore/totalMaxScore
- `src/eval/datasetLoader.ts`：zod schema 补齐全部新字段
  （zod 默认剥离未知 key，不补会静默丢字段；有回归测试守护）
- `apps/cli/src/eval.ts`：逐任务显示 `score=X/Y`，失败时打印未命中 checkpoint 明细，
  汇总打印 checkpoint 总分
- `eval-datasets/capability/`：新题库目录（loader 原生递归支持）
  - `l2-timeout-double.json`：L2 工具链样例
  - `l6-weekly-report-sample.json`：L6 checkpoint 计分样例
- `tests/eval/capability-assertions.test.ts`：8 个新测试
  （纯断言 ×2、组合断言、反向断言、forbiddenFiles、workspace 隔离回归、checkpoint 部分给分/满分）

## 题库格式样例（L6 checkpoint 计分）

```json
{
  "id": "l6-weekly-report-sample",
  "prompt": "把 reports/ 下的日报汇总成 weekly.md……",
  "initialWorkspace": { "reports/daily-mon.md": "……" },
  "checkpoints": [
    { "id": "report-file", "points": 2,
      "expectedFiles": [{ "path": "weekly.md", "containsAll": ["完成", "风险"] }] },
    { "id": "counts", "points": 1, "finalAnswerContainsAll": ["3", "1"] },
    { "id": "tools",  "points": 1, "requiredTools": [{ "name": "read_file" }] }
  ],
  "capabilities": ["planning", "file-ops"],
  "difficulty": "hard"
}
```

## 验证结果

- `pnpm build` 通过
- `pnpm test`：47 文件 294 测试全过（eval 目录 4 文件 39 测试，
  含 workspace 隔离回归与 zod 字段保留回归）
- CLI mock 链路：`pnpm eval` 内置 20/20 通过；
  `pnpm eval --dataset eval-datasets/capability` 2/2 通过，checkpoint 显示 `score=4/4`

## 后续（未做）

- 按已审定的 40 题清单（L1-L5 30 题 + L6 10 题）批量编写 scenario JSON
- 真实模型跑分 + SimpleLoop/PlanningLoop 双对照 + 裸模型对照
- 按 capabilities/difficulty 标签聚合的能力记分卡输出
