# 能力评测 v1 报告（2026-07-17）

- **模型**：deepseek-v4-flash（DeepSeek API）
- **题库**：eval-datasets/capability，40 题（L1×5 / L2×8 / L3×5 / L4×7 / L5×5 / L6×10）
- **运行**：`pnpm eval --real --dataset .../capability [--planning] --trace`
- **原始数据**：`run-simpleloop.log` / `run-planningloop.log` + 两个 traces.db

## 一、总分（SimpleLoop，有效）

**33/40 通过（83%），checkpoint 得分 62/77（81%），407k tokens，总耗时 5 分 46 秒**

| 档位 | 通过率 | 说明 |
|---|---|---|
| L1 单工具 | 5/5 | 全过 |
| L2 工具链 | 8/8 | 全过 |
| L3 检索+文件 | 3/4 | capital-check 未调 web_search |
| L4 陷阱恢复 | 6/7 | stale-note 判分误伤（见下） |
| L5 多目标规划 | 5/5（21/21 分） | 全过 |
| L6 真实场景 | 6/10（41/56 分） | 4 个失败中 3 个是判分/题目缺陷 |

**裸模型对照逻辑成立**：绝大多数题无工具做不了（答案藏在 fixture 里），83% 基本就是 agent 架子的真实产出。

## 二、失败分类（7 个失败逐一核查 trace + workspace 残骸）

### A. 判分/题目缺陷（5 个，应修题，不算 agent 能力差）

| 任务 | 真相 | 处置建议 |
|---|---|---|
| l4-stale-note | agent 正确回答 sunny-2084，只是解释时提到了过期密码 hunter2 | notContains 过严。改为只禁"密码是 hunter2"类表述 |
| l6-weekly-report | 写到了 reports/weekly.md（放在日报旁边，合理） | prompt 明确"写到 workspace 根目录" |
| l6-organize-incoming | 整理到 incoming/images/ 等子目录（"子目录"的自然理解） | prompt 明确"在 incoming/ 内部分类" |
| l6-incident-triage | 根因写对（deploy v2.4.1），但把 disk 85% 列为次要因素 | 争议：disk 属于合理相关因素。建议 no-blame 只罚"慢查询" |
| l6-reconcile | 总额算 1150（含短款 50），预期 1100（仅全未付） | "未收总额"语义歧义。checkpoint 接受 1100/1150 |

### B. 题目设计缺陷（1 个）

| 任务 | 真相 | 处置建议 |
|---|---|---|
| l3-capital-check | 首都问题是常识，agent 凭内部知识答对，没有动机调 web_search | 换成必须检索的事实（如人口普查数据），否则测不到检索能力 |

### C. 真能力失败（1 个，本次评测最有价值的发现）

**l6-config-migration：幻觉式完成。**
trace 显示 agent 读完所有文件、分析了迁移规则，然后**从未调用 write_file 或任何成功的写入命令**，最终回答却声称"✅ 新增 config.yaml、✅ 更新 loader.py"并附完整内容。workspace 残骸证实两个文件都没动。
失败链的诱因：`read_file config.ini` 被 sandbox 拒绝（见下），agent 改用 `cat` 绕行后心态"保守化"，全程没敢碰写工具。**这是"声称做了但没做"的典型 agent 失败模式，轨迹断言（文件终态）正是为抓它设计的。**

## 三、意外但重大的产品发现：read_file 白名单缺陷

`Sandbox.isTextFile()` 白名单**不含 .csv / .ini / .log**：
- 本次多个任务里 agent 的 `read_file` 被拒绝后被迫用 `run_command cat` 绕行（l1-csv-lines、l2-sum-two-csv、l6-config-migration 等均可见）
- 绕行浪费步骤、增加 token，在 config-migration 中直接诱发失败螺旋
- **建议**：白名单补 `.csv .ini .log .env .conf .xml .toml .txt 无扩展名` 等常见文本格式

## 四、PlanningLoop vs SimpleLoop 对照（已重跑，有效）

首次运行在第 12 题处因账户余额 402 作废；充值后重跑全量有效。**注意：两次对照用的是同一份未修改的题库**，保证可比性。

| 指标 | SimpleLoop | PlanningLoop | 倍数 |
|---|---|---|---|
| 通过率 | **33/40（83%）** | 30/40（75%） | -3 |
| checkpoint 得分 | **62/77** | 56/77 | -6 |
| 总 tokens | **407k** | 870k | 2.1× |
| 总耗时 | **346s** | 1427s | 4.1× |

### 分档对比

| 档位 | SimpleLoop | PlanningLoop | 解读 |
|---|---|---|---|
| L1 单工具 | 5/5 | 5/5 | 打平，但 P 慢 3.7×（平均 11.8s vs 3.2s/题） |
| L2 工具链 | 8/8 | 7/8 | P 在 sum-two-csv 上改用 run_command 写文件被 requiredTools 判死 |
| L3 检索+文件 | 4/5 | **5/5** | P 在 capital-check 上被 plan 强制走了检索路径（101k tokens！） |
| L4 陷阱恢复 | 6/7 | **7/7** | stale-note 措辞差异（非确定性） |
| L5 多目标规划 | **5/5** | 4/5 | P 在 cleanup-classify 没建 large/small.txt |
| L6 真实场景 | **6/10（41/56）** | 4/10（35/56） | 见下 |

### L6 关键对局

| 题目 | SimpleLoop | PlanningLoop | 解读 |
|---|---|---|---|
| **l6-config-migration** | ❌ 1/5 幻觉式完成 | ✅ **5/5** | **本轮最重要对局**：P 用 3 次 plan + 19 步 + 2 次反思逼自己真写入真验证，治好了幻觉式完成（120s/78k tokens） |
| l6-api-migration | ✅ 5/5 | ❌ 2/5 | P 回退：4 个文件没换成新地址 |
| l6-fix-build | ✅ 5/5 | ❌ 2/5 | P 回退：dist/banner.txt 存在但内容错（手建文件而非跑通脚本） |
| l6-competitor-research | ✅ 7/7 | ❌ 5/7 | P 回退：凭记忆没检索，Valkey 发起方答错 |
| l6-clean-csv | ✅ 5/5 | ❌ 4/5 | P 小回退："扔了 9 行"数字没说对 |
| 其余 4 题 | 同样的判分缺陷 | 同样 | 路径歧义/语义歧义题两边表现一致 |

### 结论（pass@1 单跑，±波动需注意）

1. **总体 PlanningLoop 不划算**：分更低、贵 2.1×、慢 4.1×（deepseek-v4-flash 这个档位）
2. **但硬任务上价值独特**：唯一通过 config-migration 的版本——规划+反思对"多步协调+自我校验"型任务有真实增益
3. **简单题纯浪费**：L1 无收益还慢 3.7×
4. **→ 量化支持 auto-planning（按需触发）路线**：简单任务 SimpleLoop、检测到复杂任务再升 PlanningLoop，两档分数差就是分流的依据
5.  caveat：单跑非确定性明显（stale-note/sum-two-csv/competitor-research 两边结果互摆），趋势可信、单题分数不可全信；强模型从规划获益可能更多

## 五、修复清单（待确认后执行）

题目/判分修复（改生成器重新生成）：
1. l4-stale-note：notContains 放宽为"密码是 hunter2"类断言表述
2. l6-weekly-report：prompt 加"写到 workspace 根目录"
3. l6-organize-incoming：prompt 加"在 incoming/ 内部建立分类子目录"
4. l6-incident-triage：no-blame 只罚"慢查询/slow query"，放开 disk（合理相关）
5. l6-reconcile：total checkpoint 接受 ["1100", "1150"]
6. l3-capital-check：改题为检索必需（城市人口对比）
7. requiredTools 语义讨论：l2-sum-two-csv(PlanningLoop) 用 run_command 写文件被判死——是否接受"等效工具"？

产品修复（独立提交）：
8. Sandbox.isTextFile 白名单补 .csv/.ini/.log 等

流程修复（已做）：
9. ✅ 千分位数字归一（9,200 ≈ 9200），smoke 阶段抓到并修复
