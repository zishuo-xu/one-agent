import { EvalTask } from '../types.js';

export const emptyWorkspaceQueryTask: EvalTask = {
  id: 'empty-workspace-query',
  name: '空目录查询',
  description: 'Agent 在空 workspace 中查询文件时应说明没有文件',
  prompt: '请列出当前目录下的所有文件并告诉我内容',
  requiredTools: [{ name: 'list_files' }],
  finalAnswerContains: ['没有', '空', 'no files', 'empty', '无文件'],
  enablePlanning: false,
  timeoutMs: 30000,
};
