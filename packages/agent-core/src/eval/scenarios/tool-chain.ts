import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

export const toolChainTask: EvalTask = {
  id: 'tool-chain',
  name: '工具链：读取后写入',
  description: 'Agent 读取 source.txt 内容，再将其写入 copy.txt，验证数据依赖的工具链和文件产出。',
  prompt: '读取 source.txt 的内容，然后把同样的内容写入 copy.txt。',
  initialWorkspace: {
    'source.txt': 'Hello from source file.',
  },
  // Exact-order regression: read_file must come before write_file.
  expectedTools: [
    { name: 'read_file', arguments: { path: 'source.txt' } },
    { name: 'write_file', arguments: { path: 'copy.txt', content: 'Hello from source file.' } },
  ],
  expectedFiles: [{ path: 'copy.txt', contains: 'Hello from source file.' }],
  finalAnswerContains: ['copy', '写入', 'done', '完成'],
  enablePlanning: false,
  timeoutMs: 30000,
  mockResponses: [
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'source.txt' } }]),
    createToolCallResponse([{ id: 'call_2', name: 'write_file', arguments: { path: 'copy.txt', content: 'Hello from source file.' } }]),
    {
      ...createTextResponse('已将 source.txt 的内容写入 copy.txt。'),
      usage: { prompt_tokens: 200, completion_tokens: 25, total_tokens: 225 },
    },
  ],
};
