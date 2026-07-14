import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

const firstPlanResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          reasoning: 'Read missing.txt to answer.',
          steps: [
            { id: '1', description: 'Read missing.txt', toolName: 'read_file', expectedOutcome: 'Content retrieved' },
          ],
        }),
      },
    },
  ],
};

const replanJudge = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          complete: false,
          reasoning: 'The file does not exist, need to replan.',
          nextAction: 'replan',
          failureAnalysis: {
            category: 'tool_failure',
            affectedStepIds: ['1'],
            rootCause: 'File missing.txt not found.',
            recommendation: 'Read data.txt instead.',
          },
        }),
      },
    },
  ],
};

const secondPlanResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          reasoning: 'Read data.txt instead.',
          steps: [
            { id: '1', description: 'Read data.txt', toolName: 'read_file', expectedOutcome: 'Content retrieved' },
          ],
        }),
      },
    },
  ],
};

const finalizeJudge = {
  choices: [
    {
      message: {
        content: JSON.stringify({ complete: true, reasoning: 'Done', nextAction: 'finalize' }),
      },
    },
  ],
};

export const replanScenarioTask: EvalTask = {
  id: 'replan-scenario',
  name: '规划失败后重规划',
  description: '第一个计划引用不存在的文件，Judge 判定 replan，Agent 重新规划并成功读取正确的文件。',
  prompt: '读取 missing.txt 并告诉我内容。如果文件不存在，请找到正确的文件。',
  initialWorkspace: {
    'data.txt': 'The correct data is here.',
  },
  requiredTools: [{ name: 'read_file', arguments: { path: 'data.txt' } }],
  finalAnswerContains: ['correct data', '正确的数据', 'data'],
  enablePlanning: true,
  timeoutMs: 60000,
  mockResponses: [
    firstPlanResponse,
    // First attempt: read missing.txt -> fails (tool returns error, Judge says replan)
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'missing.txt' } }]),
    replanJudge,
    secondPlanResponse,
    // Second attempt: read data.txt -> succeeds
    createToolCallResponse([{ id: 'call_2', name: 'read_file', arguments: { path: 'data.txt' } }]),
    finalizeJudge,
    {
      ...createTextResponse('The correct data is here.'),
      usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 },
    },
  ],
};
