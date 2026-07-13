import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

export const readFileTask: EvalTask = {
  id: 'read-file',
  name: '读取文件',
  description: 'Agent 读取 notes.txt 并总结内容',
  prompt: 'Summarize the content of notes.txt',
  initialWorkspace: {
    'notes.txt': 'Meeting notes:\n1. Finish trace store\n2. Add evaluation runner\n3. Run regression tests',
  },
  requiredTools: [{ name: 'read_file', arguments: { path: 'notes.txt' } }],
  finalAnswerContains: ['trace', 'evaluation', 'tests'],
  enablePlanning: false,
  mockResponses: [
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.txt' } }]),
    createTextResponse('The notes mention trace, evaluation, and tests.'),
  ],
};
