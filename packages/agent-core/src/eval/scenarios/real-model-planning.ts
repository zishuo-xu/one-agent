import { EvalTask } from '../types.js';
import { createToolCallResponse, createTextResponse } from '../fixtures.js';

const planResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          reasoning: 'Read notes.txt to answer.',
          steps: [
            { id: '1', description: 'Read notes.txt', toolName: 'read_file', expectedOutcome: 'Content retrieved' },
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

export const realModelPlanningTask: EvalTask = {
  id: 'real-model-planning',
  name: 'Real model planning with tool constraints',
  description: 'A scenario suitable for real-model evaluation: the agent should plan and use the read_file tool to answer a question.',
  prompt: 'Read the file notes.txt and tell me the main topic.',
  initialWorkspace: {
    'notes.txt': 'The main topic is artificial intelligence and its impact on software engineering.',
  },
  requiredTools: [{ name: 'read_file' }],
  finalAnswerContains: ['artificial intelligence', 'software engineering', 'topic'],
  enablePlanning: true,
  timeoutMs: 120000,
  mockResponses: [
    planResponse,
    createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.txt' } }]),
    judgeResponse,
    createTextResponse('The main topic is artificial intelligence and software engineering.'),
  ],
};
