import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

const planResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          reasoning: 'Read the data file.',
          steps: [
            { id: '1', description: 'Read data.txt', toolName: 'read_file', expectedOutcome: 'File content retrieved' },
          ],
        }),
      },
    },
  ],
};

const judgeResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({ complete: true, reasoning: 'Done', nextAction: 'finalize' }),
      },
    },
  ],
};

export const planningTask: EvalTask = {
  id: 'planning',
  name: '规划并执行',
  description: 'Agent 先制定计划，再使用工具读取文件并给出最终答案',
  prompt: 'Use the read_file tool to read data.txt, then tell me what it contains.',
  initialWorkspace: {
    'data.txt': 'Project status: green.',
  },
  requiredTools: [{ name: 'read_file', arguments: { path: 'data.txt' } }],
  finalAnswerContains: ['green', 'green'],
  enablePlanning: true,
  timeoutMs: 60000,
  mockResponses: [
    planResponse,
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'data.txt' } }]),
    judgeResponse,
    createTextResponse('Project status is green.'),
  ],
};
