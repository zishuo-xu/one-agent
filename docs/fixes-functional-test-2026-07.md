# 功能测试反馈修复（2026-07）

> 文档状态：历史工程记录（非当前缺陷清单）
> 阅读说明：本文记录对应功能测试问题的修复证据；测试数量和代码位置按当时提交保留。当前限制见 [项目现状](./project-vision-and-status.md)，历史分类见 [文档索引](./README.md)。

**日期**：2026-07-17
**关联**：`docs/functional-test-report-2026-07.md`（24 用例功能测试）、`docs/correctness-fixes.md`
**范围**：测试报告确认的 7 个问题全部修复，另加规划空转 prompt 修复；全部经单测 + 真实模型端到端复测。

---

## P0-1 run_command 绕过文件沙箱（B2，严重）

**问题**：文件工具经 Sandbox 拦截 `../`，但模型改用 `run_command` 执行 `cat ../secret.txt` 成功读取工作区外文件，秘密内容完整进入对话。`shellExec.ts` 的 blocklist 只覆盖 sudo/rm -rf 等 8 类命令，对路径零过滤。

**修复**：新增 `assertCommandContained(command, rootPath)`，与既有 `assertCommandSafe` 串联：
- `..` 路径段（任意位置：`../x`、`dir/../x`、裸 `cd ..`）→ 拒绝
- `~` 家目录引用 → 拒绝
- 绝对路径必须位于 `sandbox.rootPath` 之下
- 拒绝信息引导模型改用相对路径或文件工具；工具描述同步声明约束

**边界说明**：仍非硬安全边界（`$()`/反引号/变量展开可绕过静态检查），文件头注释如实标注；本次实证的三条绕过路径（`../`、绝对路径、`~`）已关闭。

**验证**：单测 12 条逃逸命令全拒、9 条合法命令全放行；端到端重放 B2 攻击——模型直接拒用 `..`，未尝试绕行，DB 直查秘密内容零泄露（tool_calls/traces 均无）。

## P0-2 中文长期记忆召回失效（F11，高）

**问题（两层）**：
1. `extractKeywords` 按空格分词，中文整句成一个 keyword，LIKE 永不命中中文 key（报告实证）
2. 复测发现第二层：MemoryExtractor 可能把中文事实归一为英文 key，中文问句依然无法命中

**修复**：
- `extractKeywords`：CJK 连续段切滑动二元组（`我最喜欢的编程语言` → `我最,喜欢,的编,编程,…`），过滤全停用字 bigram；英文逻辑不变，SQL 不变
- `MemoryExtractor` prompt：keys 使用与用户消息相同的语言，保证同语言查询可命中

**验证**：单测（中文问句命中中文 key、不相关中文记忆不误中、跨 thread 集成中文变体）；端到端：thread1「我最喜欢的编程语言是 Rust」→ 中文 key 入库 → thread2 中文提问 → 正确回答 Rust。

## P1-3 波次重试重跑成功子 Agent（成本）

**问题**：波次重试只把 failed 步骤重置 pending，但波次入口无条件重跑全部步骤——成功的苹果子 Agent 被完整重跑 3 次（约 2.1 万 token 浪费）。

**修复**：波次（重）进入时与 `executeWave` 内均跳过 `status === 'completed'` 的步骤；完成步骤的结果已在 reasoningChain/上下文中。

**验证**：单测断言波次一败一成 + retry → 成功步骤子 Agent 恰好执行 1 次，失败步骤按波次重跑。

## P1-4 迭代上限丢弃全部中间工作

**问题**：`runSimpleLoop` 撞 `maxToolIterations` 直接 throw，子 Agent 中间成果只剩 trace，父 agent 只收到裸 FAILED。

**修复**：撞上限时改为一次**无工具收尾调用**（`callModelStreaming({ includeTools: false })`，追加「工具预算已用尽，请基于已有信息直接总结」的 internal 消息），结果作为 reply 正常返回；收尾调用本身失败才抛出。子 Agent 因此能把部分成果带回父 agent。

**验证**：单测三层——循环级（wrap-up 调用无 tools + reply 为总结）、子 agent 级（success=true 含部分结论）、收尾失败仍抛出；旧测试「无 executor 时撞上限抛错」按新行为更新。

## P2-5 推理文本双打印

**问题**：reasoning 经 `reasoning_delta` 逐 token 打印后，流结束若无正文，`callModelStreaming`/`streamModel` 又把整段 reasoningBuffer 作为 `message_delta` 重放一遍。

**修复**：两处删除重放（`content = reasoningBuffer` 保留作返回值）。

**验证**：单测断言 reasoning-only 响应的事件序列：`reasoning_delta × N` 后无整段 `message_delta`。

## P2-6 /threads 时区偏差 8 小时

**问题**：ThreadStore/MessageStore/ToolCallStore 用 `datetime('now')` 存 UTC 无时区标记，V8 将 `'YYYY-MM-DD HH:MM:SS'` 当本地时间解析 → UTC+8 下新会话显示「8 小时前」。

**修复**：新增 `db/dateTime.ts` 的 `normalizeUtcDateTime`（无 `T` 的补 `T`+`Z`），在三个 store 的 row mapper 读边界归一（免迁移；已写 toISOString 的 store 不受影响）。

**验证**：单测 mapper 归一断言；真实 CLI `/threads` 新会话显示「20 秒前」。

## P2-7 /traces 被逐 token 事件淹没

**修复**（`apps/cli/src/commands/traces.ts`）：移植 trace-web 的分组——连续同型 delta 合并一行（`message_delta × 128: "预览…"`），limit 按分组后计数；补 `reasoning_delta`/`sub_agent` 摘要 case；`--verbose` 真正解除 limit（原 `?? 20` 把 undefined 按回 20）。

## P3 规划循环空转（s7 发现）

**问题**：文件不存在时 replan 产出「请求用户提供路径」类步骤，非交互下空转 96.5s/1.16 万 token 才放弃。

**修复**（prompt 级）：Planner 增「不得规划等待用户输入的步骤；缺信息时用合理假设并在最终答案注明」；TaskJudge 增「不应为等待用户输入而 replan，无法推进时 finalize 并说明缺失」。

---

## 测试汇总

| 包 | 测试数 | 结果 |
|---|---|---|
| agent-core | 45 文件 / 275 | ✅ |
| api | 27 | ✅ |
| cli | 62 | ✅ |
| trace-web | 9 | ✅ |

合计 373，新增 17（shell-exec 2、memoryStore 2、persistence-memory 1、delegated-steps 1、correctness-fixes 2、sub-agent-runner 1、threadStore 1、trace-command 2、英文基线零改动）。

## 遗留观察

- **记忆 key 去重**：同一事实可能因多轮提取重复入库（`最喜欢的编程语言` × 2）。MemoryStore.create 无按 key upsert，留作后续小改进。
- **web_search DuckDuckGo 空结果**：外部依赖问题，模型内部知识兜底表现好，未动。
- **老数据英文 key**：修复前已入库的英文 key 对中文查询仍不可召回（新提取已语言一致），如需可写一次性迁移脚本重新归一。
