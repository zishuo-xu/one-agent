import { EvalTask } from '../types.js';

export const listThenReadTask: EvalTask = {
  id: 'list-then-read',
  name: '先列目录再读取',
  description: 'Agent 先列出 workspace 文件，再读取目标文件',
  prompt: 'List the files in the workspace and then read report.txt',
  initialWorkspace: {
    'report.txt': 'Q3 revenue increased by 12%.',
  },
  requiredTools: [
    { name: 'list_files' },
    { name: 'read_file', arguments: { path: 'report.txt' } },
  ],
  finalAnswerContains: ['revenue', '12%'],
  enablePlanning: false,
};
