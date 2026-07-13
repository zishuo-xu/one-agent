import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

export const fileNotFoundRecoveryTask: EvalTask = {
  id: 'file-not-found-recovery',
  name: '文件缺失后恢复',
  description: 'Agent 读取不存在的文件后能列出目录并找到正确文件',
  prompt: 'Read the meeting notes file',
  initialWorkspace: {
    'notes.txt': 'Meeting: discuss idempotency and evaluation.',
  },
  requiredTools: [{ name: 'list_files' }, { name: 'read_file', arguments: { path: 'notes.txt' } }],
  finalAnswerContains: ['idempotency', 'evaluation', 'Meeting'],
  enablePlanning: false,
  timeoutMs: 30000,
  mockResponses: [
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.md' } }]),
    createToolCallResponse([{ id: 'call_2', name: 'list_files', arguments: {} }]),
    createToolCallResponse([{ id: 'call_3', name: 'read_file', arguments: { path: 'notes.txt' } }]),
    createTextResponse('The notes say: discuss idempotency and evaluation.'),
  ],
};
