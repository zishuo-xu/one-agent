import { EvalTask } from '../types.js';

export const createTodoTask: EvalTask = {
  id: 'create-todo',
  name: '创建待办文件',
  description: 'Agent 根据用户要求创建并写入 todo.md',
  prompt: '请帮我创建一个 todo.md 文件，记录今天要完成的 3 个任务',
  requiredTools: [{ name: 'write_file' }],
  finalAnswerContains: ['todo', '任务', '完成'],
  expectedFiles: [{ path: 'todo.md', contains: '任务' }],
  enablePlanning: false,
  timeoutMs: 30000,
};
