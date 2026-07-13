import { EvalTask } from '../types.js';

export const multiToolPlanningTask: EvalTask = {
  id: 'multi-tool-planning',
  name: '多工具规划',
  description: 'Agent 在规划模式下先列出文件再读取目标文件',
  prompt: '请列出当前目录的 txt 文件，然后读取第一个并总结内容',
  initialWorkspace: {
    'notes.txt': 'Today: finish evaluation and add idempotency.',
  },
  requiredTools: [{ name: 'list_files' }, { name: 'read_file' }],
  finalAnswerContains: ['evaluation', 'idempotency', 'Today', 'finish'],
  enablePlanning: true,
  timeoutMs: 60000,
};
