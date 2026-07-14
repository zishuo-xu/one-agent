import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

export const getTimeTask: EvalTask = {
  id: 'get-time',
  name: '获取当前时间',
  description: 'Agent 必须调用 get_time 工具来回答当前时间相关问题。',
  prompt: '现在几点了？',
  requiredTools: [{ name: 'get_time' }],
  finalAnswerContains: ['时间', '点', 'time'],
  enablePlanning: false,
  timeoutMs: 30000,
  mockResponses: [
    createToolCallResponse([{ id: 'call_1', name: 'get_time', arguments: {} }]),
    {
      ...createTextResponse('当前时间是 2026 年 7 月 14 日 14:30。'),
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    },
  ],
};
