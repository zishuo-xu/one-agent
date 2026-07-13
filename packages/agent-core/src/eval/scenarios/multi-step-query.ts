import { EvalTask } from '../types.js';

export const multiStepQueryTask: EvalTask = {
  id: 'multi-step-query',
  name: '多步文件查询',
  description: 'Agent 先列出 txt 文件，再读取第一个文件',
  prompt: '请列出当前目录下的所有 txt 文件，然后读取第一个 txt 文件并告诉我内容',
  initialWorkspace: {
    'notes.txt': 'Meeting: discuss trace and evaluation.',
    'report.txt': 'Q3 status: all green.',
  },
  requiredTools: [{ name: 'list_files' }, { name: 'read_file' }],
  finalAnswerContains: ['Meeting', 'trace', 'evaluation', 'notes'],
  enablePlanning: false,
  timeoutMs: 30000,
};
