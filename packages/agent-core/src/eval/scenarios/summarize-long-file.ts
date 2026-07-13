import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

export const summarizeLongFileTask: EvalTask = {
  id: 'summarize-long-file',
  name: '长文本摘要',
  description: 'Agent 读取长文件并给出关键摘要',
  prompt: '请阅读 long-report.txt 并用一句话总结核心内容',
  initialWorkspace: {
    'long-report.txt': `
第一章 概述
本项目旨在构建一个简化版的单 Agent 运行时，帮助开发者深入理解 Agent 的核心机制。

第二章 架构
系统包含 AgentLoop、ToolRegistry、ContextManager、Planner、TaskJudge 等模块。

第三章 持久化
使用 SQLite 保存 threads、messages、runs、tool_calls、tasks、trace_events 和 memories。

第四章 评估
通过 EvalRunner 运行确定性场景，验证 Agent 在工具调用、规划、错误恢复等方面的能力。

第五章 结论
核心结论是：一个清晰的单 Agent 生命周期理解，是构建更复杂多 Agent 系统的基础。
`.trim(),
  },
  requiredTools: [{ name: 'read_file', arguments: { path: 'long-report.txt' } }],
  finalAnswerContains: ['Agent', '运行时', '核心', 'persistence', '评估', '能力'],
  enablePlanning: false,
  timeoutMs: 30000,
  mockResponses: [
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'long-report.txt' } }]),
    createTextResponse('The core idea is to build a single-agent runtime and evaluate its capabilities.'),
  ],
};
