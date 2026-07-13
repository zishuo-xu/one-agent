import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

export const invalidArgRetryTask: EvalTask = {
  id: 'invalid-arg-retry',
  name: '错误参数后重试',
  description: 'Agent 最终读取到正确的 notes.txt 并总结内容',
  prompt: 'Read the notes file',
  initialWorkspace: {
    'notes.txt': 'Reminder: buy milk.',
  },
  requiredTools: [{ name: 'read_file', arguments: { path: 'notes.txt' } }],
  finalAnswerContains: ['milk', '牛奶'],
  enablePlanning: false,
  timeoutMs: 30000,
  mockResponses: [
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'wrong.txt' } }]),
    createToolCallResponse([{ id: 'call_2', name: 'read_file', arguments: { path: 'notes.txt' } }]),
    createTextResponse('The reminder is to buy milk.'),
  ],
};
