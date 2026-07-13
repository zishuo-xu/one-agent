import { EvalTask } from '../types.js';

export const simpleQaTask: EvalTask = {
  id: 'simple-qa',
  name: '简单问答',
  description: 'Agent 直接回答，无需调用工具',
  prompt: 'What is the capital of France?',
  finalAnswerContains: ['Paris', '巴黎'],
  enablePlanning: false,
};
