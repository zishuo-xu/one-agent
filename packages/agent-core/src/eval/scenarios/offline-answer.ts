import { EvalTask } from '../types.js';
import { createTextResponse } from '../fixtures.js';

export const offlineAnswerTask: EvalTask = {
  id: 'offline-answer',
  name: '禁止工具的纯知识回答',
  description: '禁止使用 web_search 和 read_file，Agent 必须用自身知识回答常识问题。',
  prompt: '水的沸点是多少度？请直接回答，不要搜索或读取文件。',
  forbiddenTools: ['web_search', 'read_file'],
  finalAnswerContains: ['100', '沸点', 'boiling'],
  enablePlanning: false,
  timeoutMs: 30000,
  mockResponses: [
    {
      ...createTextResponse('水的沸点在标准大气压下是 100 摄氏度。'),
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    },
  ],
};
