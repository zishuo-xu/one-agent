import { EvalTask } from '../types.js';

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
};
