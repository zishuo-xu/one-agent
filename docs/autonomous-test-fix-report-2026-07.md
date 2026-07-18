# 自主测试与修复报告

> 文档状态：历史工程记录（非当前缺陷清单）
> 阅读说明：结论、测试数量和未解决项截止 2026-07-17；后续修复可能已经改变状态。当前限制见 [项目现状](./project-vision-and-status.md)，历史分类见 [文档索引](./README.md)。

**日期**：2026-07-17
**范围**：one-agent v0.1.0 全仓库（agent-core / cli / api / trace-web）
**前置资产**：`docs/feature-review-2026-07.md`（代码审查）、`docs/functional-test-report-2026-07.md`（24 用例真实模型端到端测试）

---

## 一、项目理解

- **产品定位**：学习导向的简化单 Agent 运行时（CLI 优先），无框架依赖地吃透单 Agent 完整内核：模型调用 → 工具执行 → 上下文/记忆 → 规划/自纠 → 持久化 → 观测。
- **核心功能**：流式多轮对话（摘要压缩）、10 个内置工具、规划与自我纠错（plan/plan-auto + Judge retry/replan）、长期记忆（跨 thread）、子 Agent 委派（spawn_agent + 波次并行）、SQLite 持久化、trace 观测（trace-web 嵌套展示）、eval 评估、多模型（OpenAI 兼容 + 主备 failover + 按用途分模型）。
- **启动与测试方式**：`pnpm dev:cli`（REPL，支持管道驱动）；`pnpm test`（四包 vitest）；`pnpm eval` / `pnpm --filter cli eval`（mock 场景）；`pnpm build`。测试模型 deepseek-v4-flash（真实 API）。
- **重要背景**：本轮工作期间检测到一个**并行会话在同一工作树上活跃修改**（修复了中文记忆 bigram、run_command 工作区容器化、UTC 时间归一化、/traces 折叠、波次重试跳过、迭代上限优雅收尾、推理去重、Judge prompt 约束等）。本轮策略：**不覆盖其未提交修改；对其修复只做独立验证；自己负责的修复单独提交**。

---

## 二、测试执行情况

### 执行的测试

- `pnpm test` 全量：**58 文件 / 379 测试全部通过**（agent-core 45/280、api 4/27、cli 8/62、trace-web 1/10）
- `pnpm eval`：30 通过；`pnpm --filter cli eval`：20/20（含 replan-scenario）
- `pnpm build`：通过
- 真实模型 E2E 抽查（隔离 workspace + 管道驱动 + DB 直查交叉验证）：
  - 中文记忆跨 thread 召回"Rust" ✅（修复后复测）
  - 路径穿越攻击 `读取 ../secret.txt` ✅（秘密 0 泄漏，Agent 如实拒绝并给出合规建议）
  - 推理文本单遍显示 ✅（此前每轮重复打印）
  - /threads 相对时间"刚刚" ✅（此前显示"8 小时前"）

### 新增的测试（本轮回合，不含并行会话）

| 测试 | 覆盖修复 |
|------|----------|
| planning-agent-loop +3 | replan 预算耗尽不伪装成功、偏离/失败路径 tool_calls 配对 |
| ContextManager 改写1+新增1 | 摘要失败不存错误串、下轮重试覆盖失败区间 |
| tests/db/migration.test.ts（新） | 旧 schema 迁移 + 幂等键唯一约束 |
| reasoning-chain +1 | failureAnalysis 立即提交且不泄漏到下一步 |
| delegated-steps +1 | 子 Agent usage 不锚定父级上下文估算 |
| taskQueue +2 | 重复幂等键不入队/控制器不被覆盖、已完成任务不重复执行 |
| trace-web server.test +1 | XSS 三种上下文安全构造存在、旧不安全形式不存在 |
| web-search +2 | 空结果防重试指引、配置服务不可达时回落 DuckDuckGo |

### 最终通过/失败情况

全部通过。过程中发现并修复一个**测试基础设施崩溃**：api 包 vitest 在链式运行时于全部测试通过后 SIGSEGV（exit 139）——Node 25 worker 线程 + better-sqlite3 原生模块清理竞态，与断言无关；改 `pool: 'forks'` 后稳定。

---

## 三、已修复问题（本人实施并提交，7 个检查点提交）

### 1. replan 预算耗尽时失败步骤被静默标记 completed
- **根因**：`runPlanningLoop` 的 replan 守卫不通过时控制流 fall-through 到 `status = 'completed'`。
- **修改**：补对称守卫，失败步骤保持 failed 并 finalize 如实说明（`AgentLoop.ts`）。
- **验证**：新增测试（judge 恒判 replan + 预算耗尽 → 步骤保持 failed）；全套回归。

### 2. 未配对 tool_calls 污染对话历史
- **根因**：assistant tool_calls 消息在执行前写入 context，偏离路径/多调用首失败路径留下无响应调用，严格端点拒绝后续全部请求。
- **修改**：return 前为未执行调用补占位 tool 消息（只进 context，不污染 trace/eval 断言）。
- **验证**：两条路径各有配对断言测试（`expectToolCallsPaired`）。

### 3. 摘要失败永久销毁历史
- **根因**：`summarize` 吞错返回错误串当正式摘要并推进索引。
- **修改**：summarize 抛错 + `trySummarizeUpTo` 失败不推进索引、下轮自动重试（`ContextManager.ts`）。
- **验证**：mock 先失败后成功，断言重试覆盖失败区间。

### 4. tasks.idempotency_key 老库迁移失败
- **根因**：SQLite 禁止 ALTER 加 UNIQUE 列，错误被吞导致列缺失；INIT_SQL 冗余索引对旧表同样抛错。
- **修改**：普通列 + 部分唯一索引；删除 INIT_SQL 冗余索引（`connection.ts`）。
- **验证**：新 migration 测试（旧 schema → migrate → 幂等去重 + 唯一约束生效）。

### 5. Judge 判定时看不到刚发生的失败分析
- **根因**：`addFailureAnalysis` 写入 ambient currentStep 但不 commit，`getSteps()` 为空证据。
- **修改**：`addFailureAnalysis` 立即 commit（`ReasoningChain.ts`），同时修复失败状态泄漏到下一步。
- **验证**：单测（立即可见 + 下一步不被误染）。

### 6. 子 Agent token 汇总污染父上下文记账
- **根因**：子 Agent 的小 promptTokens 写入父级 `lastKnownPromptTokens`，父级低估自身上下文、跳过摘要。
- **修改**：`accumulateUsage` 增加 `trackPromptSize` 选项，runSubAgent 传 false（`AgentLoop.ts`）。
- **验证**：集成测试（spy 断言 5000 被锚定、子 Agent 的 50 永不锚定）。

### 7. TaskQueue 重复幂等键重复执行 + 取消失效
- **根因**：enqueue 无条件覆盖 map 项与 re-push pending；store 对已见键返回既有任务。
- **修改**：检测到既有任务（已跟踪或状态非 pending）直接返回不入队（`TaskQueue.ts`）。
- **验证**：+2 测试（控制器不被覆盖/pending 计数为 1；已完成任务不重复执行）。

### 8. trace-web 存储型 XSS（两处三上下文）
- **根因**：`escapeHtml` 不转义引号却用于 `title="..."`；DB id 原样插入 `onclick='...'`（JS 字符串+属性双重上下文）；item-meta 的 id/status 未转义进 innerHTML。
- **修改**：escapeHtml 补引号转义；onclick 改 `escapeHtml(JSON.stringify(id))`；item-meta/timeline 补转义（`server.ts`）。
- **验证**：+1 测试（安全构造存在、旧不安全形式不存在）。

### 9. web_search 降级链断裂 + 空结果引发重试风暴
- **根因**：配置的搜索服务 fetch 无 try/catch（不可达时 DuckDuckGo 兜底走不到）；空结果文案不阻止模型反复重试（功能测试中子 Agent 4 连败、浪费约 5 万 token）。
- **修改**：`searchWithConfigApi` 补 try/catch 回落；空结果 summary 加"不要反复重试、改用自身知识"指引（`webSearch.ts`）。
- **验证**：+2 测试（不可达服务回落 DDG、空结果指引存在）。

### 10. api 包 vitest 链式运行段错误（测试基础设施）
- **根因**：Node 25 worker 线程 + better-sqlite3 原生模块清理竞态，测试全过后进程 teardown 阶段 SIGSEGV。
- **修改**：`apps/api/vitest.config.ts` 设 `pool: 'forks'`（用崩溃报告堆栈 + pool 对照实验定位）。
- **验证**：链式全量 379 测试两次稳定通过。

### 并行会话实施、本人独立验证的修复（其文件保持其未提交状态）

| 修复 | 验证方式 |
|------|----------|
| 中文记忆 CJK bigram 分词召回（memoryStore） | 单测 9/9 + 关键词级脚本 + 真实模型 E2E（新 thread 召回 Rust） |
| run_command 工作区容器化（`..`/`~`/外部绝对路径拒绝） | 单测 8/8 + E2E 攻击复测（0 泄漏） |
| UTC 时间归一化 normalizeUtcDateTime（/threads 时区） | 相关 30 测试 + E2E"刚刚" |
| 波次重试跳过已完成步骤 | delegated-steps 测试（goodCalls===1） |
| 迭代上限优雅收尾（不再 throw 丢弃工作） | 代码审查确认 + 回归 |
| 推理文本去重（流式后不再重发） | E2E 单遍显示 |
| Judge prompt 禁止"为等用户输入而 replan" | 代码审查确认（prompt 级，未单独 E2E） |
| /traces 折叠 delta 事件 + verbose 展开 | 代码审查确认 + cli 62 测试 |

---

## 四、未解决问题

| 问题 | 现象 | 未解决原因 | 严重程度 | 推荐下一步 |
|------|------|-----------|----------|-----------|
| web_search 真实召回率差 | DuckDuckGo 对多数查询返回空 | ~~外部环境阻塞~~ **已解决（2026-07-17）**：配置 Tavily（`SEARCH_API_URL`/`SEARCH_API_KEY`）后实测中英查询均返回真实结果；s8 子 Agent 场景复测 224s→73s、4 连败→一次成功 | ✅ | — |
| （根因补充）IA 兜底端点对 Node 失效 | `api.duckduckgo.com` 对 Node TLS 指纹返回 200 空 body（curl 正常），IA 兜底从未生效 | 外部服务反爬策略 | 🟡 中 | Tavily 已替代该路径；如需保留免费兜底可验证 lite.duckduckgo.com |
| 波次共享 ReasoningChain 并发竞态 | 并行步骤 thought 互相覆盖、planStepId 归属不定 | 需重构 ambient currentStep 为 per-step builder，改动面较大 | 🟡 中 | 下批结构重构时处理（review P0-3） |
| TaskQueue 崩溃恢复链路 | `restore()` 无人调用、恢复的 running 任务堵死并发槽 | 需定义恢复策略（requeue vs fail）并接线 API 启动路径 | 🟡 中 | 恢复策略明确后一并修（review P0-7） |
| shellExec 子进程继承全部环境变量 | `run_command: env` 可读 OPENAI_API_KEY | 容器化已修路径、env scrub 未做 | 🟡 中（安全） | env 白名单 scrub；API 部署 DISABLED_TOOLS |
| API SSE 终态竞态/无心跳 | 注册监听器与状态检查间错过完成事件则客户端永远挂起 | 本轮未到 | 🟡 中 | 注册后复查终态 + 心跳帧 |
| eval 死字段 | `expectedOutcome` 不校验、`retryCount` 恒 0 | 本轮未到 | 🟢 低 | 补齐断言实现或移除字段 |
| jsonMode 不分错误重试 / Fallback abort 误判 | 故障期负载翻倍、取消被当传输错误 | 本轮未到 | 🟢 低 | 按 review P1 方案分类错误 |
| api worker 段错误根因 | forks pool 只是规避 | Node 25 + vitest 1.6 + better-sqlite3 组合 | 🟢 低 | 升级 vitest/better-sqlite3 后可回退 pool 配置 |

---

## 五、功能状态

| 功能 | 状态 |
|------|------|
| 流式多轮对话（摘要压缩） | ✅ 已验证可用（含强制摘要 E2E） |
| 工具调用（文件/命令/搜索/时间） | ✅ 已验证可用（8/10 实测；delete_file、简单模式 spawn_agent 未单独实测） |
| 规划与自我纠错（plan/plan-auto） | ✅ 已验证可用（多步计划、失败自纠、自动分流） |
| 长期记忆（跨 thread） | ✅ 已验证可用（修复后 E2E 召回成功） |
| 子 Agent 委派（波次并行/嵌套 trace） | ✅ 已验证可用（并行波次、降级收敛均有实证） |
| SQLite 持久化与会话恢复 | ✅ 已验证可用 |
| trace 观测（CLI /traces + trace-web） | ✅ 已验证可用 |
| eval 评估 | ✅ 已验证可用（20/20） |
| 多模型 failover | ✅ 已验证可用（主端点不可达自动切换） |
| run_command 安全防护 | ⚠️ 部分可用（路径容器化已修；env 继承未 scrub；演示级 blocklist 立场见 phase13 文档） |
| web_search | ✅ 已验证可用（Tavily 配置后中英查询实测返回真实结果，E2E 复测通过） |

---

## 六、代码变更

### Git 提交记录（7 个检查点提交，按问题分组）

```
8db87bf test(api): vitest 改 forks pool，规避 Node 25 worker 线程原生模块清理段错误
83fbc21 fix(agent-core): web_search 降级链修复 + 空结果防重试指引
89309a2 fix(trace-web): 修复存储型 XSS（id/错误文本多上下文转义）
e1a2abb fix(agent-core): TaskQueue 重复幂等键不再重复入队/覆盖 AbortController
4f4bc9f fix(agent-core): Judge 证据缺失 + 子 Agent token 记账污染
903e5e3 fix(agent-core): P0 止血四项 + 功能测试报告
（外加本报告提交）
```

### 本人修改/新增文件

- 修改：`AgentLoop.ts`（replan 守卫、tool_calls 配对、token 记账）、`ContextManager.ts`（摘要失败重试）、`connection.ts`（迁移修复）、`ReasoningChain.ts`（failureAnalysis 立即提交）、`TaskQueue.ts`（幂等守卫）、`webSearch.ts`（降级链+空结果指引）、`trace-web/server.ts`（XSS）、`apps/api/vitest.config.ts`（forks pool）
- 新增测试：migration.test.ts + 8 个测试文件新增用例（共 +12 用例）
- 新增文档：feature-review、functional-test-report、本报告；correctness-fixes.md 第八节
- 数据库结构变化：`tasks.idempotency_key` 迁移路径修复（普通列+部分唯一索引），对既有数据无破坏性
- **未触碰**：并行会话的所有未提交修改（memoryStore bigram、shellExec 容器化、dateTime 归一化、CLI 改进等 20+ 文件），保持其工作区状态供其自行提交

---

## 七、最终结论

- **当前是否可以运行**：✅ 可以。构建通过、CLI/API/trace-web 可启动、全套测试稳定绿。
- **是否达到可交付标准**：**达到（对其学习项目定位而言）**。功能测试报告中的两个失败项（路径穿越泄漏、中文记忆召回）均已修复并 E2E 复测通过；三项部分通过均已缓解；核心主流程 24 用例对应功能全部可用。
- **最大剩余风险**：①web_search 无 key 时实际不可用（外部阻塞）；②波次 ReasoningChain 并发竞态在 trace 层面会产生错乱记录（不影响结果正确性）；③shellExec env 继承在多租户/API 部署场景有密钥泄漏面（本机自用无碍）。
- **下一轮最值得优先处理**：①配 `SEARCH_API_URL`/`SEARCH_API_KEY` 并复测 web_search 真实召回；②shellExec env scrub（小改动、安全收益大）；③ReasoningChain per-step builder 重构（消除波次竞态）；④TaskQueue 恢复策略定义与接线。
