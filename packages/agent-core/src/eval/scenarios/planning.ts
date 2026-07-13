import { EvalTask } from '../types.js';

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
};
