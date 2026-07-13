import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

export const writeFileTask: EvalTask = {
  id: 'write-file',
  name: '写入文件',
  description: 'Agent 创建 output.txt 并写入指定内容',
  prompt: 'Create a file named output.txt with the content "hello eval"',
  expectedTools: [{ name: 'write_file', arguments: { path: 'output.txt', content: 'hello eval' } }],
  finalAnswerContains: ['hello eval'],
  enablePlanning: false,
  timeoutMs: 30000,
  mockResponses: [
    createToolCallResponse([
      { id: 'call_1', name: 'write_file', arguments: { path: 'output.txt', content: 'hello eval' } },
    ]),
    createTextResponse('Created output.txt with "hello eval".'),
  ],
};
