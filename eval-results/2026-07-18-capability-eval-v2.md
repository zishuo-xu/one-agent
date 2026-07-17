# 能力评测 v2 报告（2026-07-18）

- **模型**：deepseek-v4-flash（DeepSeek API）
- **题库**：修复后的 `eval-datasets/capability`，40 题（L1×5 / L2×8 / L3×5 / L4×7 / L5×5 / L6×10）
- **运行方式**：SimpleLoop / PlanningLoop 各跑一次，任务级并发 4，开启 Trace
- **墙钟总时间**：457.5 秒（约 7 分 38 秒）
- **原始 Trace**：`simpleloop-v2-traces.db` / `planningloop-v2-traces.db`

## 一、总账

| 指标 | SimpleLoop | PlanningLoop | 对比 |
|---|---:|---:|---:|
| 通过率 | **35/40（88%）** | 29/40（73%） | Simple +6 题 |
| checkpoint | **71/77（92%）** | 61/77（79%） | Simple +10 分 |
| tokens | **420,139** | 697,476 | Planning 1.66× |
| 累计任务耗时 | **345.1s** | 1,235.8s | Planning 3.58× |
| 四并发墙钟耗时 | **94.6s** | 362.9s | Planning 3.84× |
| 并发利用率（累计/墙钟） | 3.65× | 3.41× | 接近四并发上限 |

并发只降低墙钟时间，不降低模型调用次数和 token 成本。相对 v1 串行耗时（Simple 346s、Planning 1427s），本轮分别缩短到 95s 和 363s。

## 二、分档结果

| 档位 | SimpleLoop | PlanningLoop |
|---|---:|---:|
| L1 单工具 | **5/5** | **5/5** |
| L2 工具链 | **8/8** | 6/8 |
| L3 检索+文件 | **5/5** | 4/5 |
| L4 陷阱恢复 | 6/7 | 6/7 |
| L5 多目标规划 | **5/5（21/21）** | 4/5（19/21） |
| L6 真实场景 | **6/10（50/56）** | 4/10（42/56） |

## 三、失败任务

### SimpleLoop（5 题）

| 任务 | 得分/失败点 |
|---|---|
| l4-stale-note | 最终答案缺少 `sunny-2084` |
| l6-api-migration | 4/5，错误修改了 distractor `scripts/s4.py` |
| l6-competitor-research | 5/7，缺少 Valkey 的 Linux Foundation 信息 |
| l6-incident-triage | 5/6，报告仍提到“慢查询” |
| l6-weekly-report | 3/5，缺少“修复NPE”事项 |

### PlanningLoop（11 题）

| 任务 | 得分/失败点 |
|---|---|
| l2-sort-csv | 未生成 `sorted.csv`，答案缺少 `leo` |
| l2-sum-two-csv | 未按题目要求调用 `read_file`（结果本身通过验证层） |
| l3-ascii-compare | 未调用要求的 `web_search` |
| l4-missing-pdf | 最终答案缺少 `9200` |
| l5-diff-dirs | 1/3，`diff.txt` 缺少 b.txt / d.txt |
| l6-api-migration | 4/5，错误修改 distractor |
| l6-competitor-research | 5/7，缺少 Linux Foundation 信息 |
| l6-config-migration | 1/5，未生成 config.yaml，loader.py 未迁移 |
| l6-fix-build | 1/5，未生成 dist/banner.txt，未报告构建成功 |
| l6-incident-triage | 5/6，报告仍提到“慢查询” |
| l6-reconcile | 4/6，最终答案缺少未收总额 |

## 四、三个关键结论

### 1. 修题和文本白名单修复有效，但总体路线结论没有改变

SimpleLoop 从 v1 的 33/40、62/77 提升到 35/40、71/77；PlanningLoop 的 checkpoint 从 56/77 提升到 61/77。修复后的题库更能反映 Agent 真实执行结果。

PlanningLoop 仍然总体更慢、更贵、分数更低。当前 deepseek-v4-flash 上，“所有任务强制规划”不成立，仍应走 auto-planning：默认 SimpleLoop，只把高复杂度、高风险、需要恢复的任务升级到 PlanningLoop。

### 2. PlanningLoop 的 pass@1 波动和失败模式仍然明显

v1 中 PlanningLoop 唯一高价值胜利是 `l6-config-migration`（5/5），本轮同题却降到 1/5；`l6-weekly-report` 则从失败变成 5/5。这再次说明单跑只能用于发现趋势和失败模式，不能把单题胜负当作稳定能力。

下一阶段如果要形成简历中可信的量化结论，应对关键 L6 任务至少跑 3 次，报告 pass@3、平均 checkpoint、方差和成本，而不是继续依赖单次 pass@1。

### 3. Verified Completion 暴露出目标级验证缺口

两轮共 16 个 Eval 失败，其中 13 个仍被完成验证器标记为 `verified`、2 个为 `partial`、1 个为 `unverified`。Eval 与完成验证器判据并不完全相同（例如 requiredTools 约束），不能把所有差异都视为误判；但以下案例明确说明当前验证粒度不足：

- Planning `l6-config-migration`：只得 1/5，核心交付物不存在，仍为 `verified`。
- Planning `l6-fix-build`：构建产物不存在且未成功，仍为 `verified`。
- Simple `l6-weekly-report`：关键事项遗漏，仍为 `verified`。

当前验证器更接近“执行过程产生过成功证据”，还不是“用户目标与每个验收条件均已满足”。对于“可靠性优先”的项目定位，这是下一步最高优先级问题。

## 五、下一步

### 第一优先级：把 Verified Completion 升级为目标/交付物级验证

让验证器基于任务目标生成或接收显式 acceptance criteria，并逐项绑定文件终态、命令结果、工具证据和计划步骤。只要关键条件未验证，就不能给出 `verified`。先用本轮 16 个失败案例建立 verifier 回归集，目标不是追求与 Eval 100% 一致，而是消灭“核心交付物不存在仍 verified”的高风险假阳性。

### 第二优先级：对关键 L6 任务做三次重复评测

优先选择 config-migration、fix-build、weekly-report、competitor-research，分别比较 SimpleLoop、PlanningLoop 和未来 auto-planning，确认规划收益在哪些任务类型上稳定存在。

## 六、发现后的处理（2026-07-18）

已按“模型无关、可靠性优先、轻量 Runtime”的定位完成第一优先级修复：

1. `tool_result` 新增 `toolCallId`，验证器按 ID 关联调用和结果；没有结果的调用被视为失败证据，避免并行调用或策略拒绝导致结果串线。
2. 对修改 workspace 的请求，只有读取/搜索证据不再足以得到 `verified`，必须观察到明确的成功变更。
3. 最终回答若明确报告“未完成、未创建、仍失败、需要继续修复”，完成状态强制降为 `partial/failed`。
4. 新增 Completion Contract：调用方可声明文件存在性、文件内容、禁止内容和最终报告条件；EvalRunner 自动把 task/checkpoint 断言转换为契约。
5. 验证过程保持确定性，不调用额外模型，不增加 token，结果继续写入 Run/Task/Trace。

验证结果：agent-core 320、API 30、CLI 69、Trace Web 10，共 429 项测试全部通过；四个应用完整构建通过；Mock Eval 20/20 通过。
