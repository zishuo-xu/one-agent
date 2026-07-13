import { EvalTask } from '../types.js';

export const projectOnboardingTask: EvalTask = {
  id: 'project-onboarding',
  name: '项目上手',
  description: 'Agent 探索项目结构并说明项目用途',
  prompt: '请帮我了解这个项目的结构和用途',
  initialWorkspace: {
    'README.md': '# one-agent\n\nA simplified single-agent runtime for learning the full agent lifecycle.',
    'package.json': JSON.stringify({
      name: 'one-agent',
      version: '0.0.1',
      description: '简化版单 Agent 运行时',
      scripts: { dev: 'pnpm dev:cli' },
    }, null, 2),
    'src/index.ts': 'console.log("Hello from one-agent");',
  },
  requiredTools: [{ name: 'list_files' }, { name: 'read_file' }],
  finalAnswerContains: ['one-agent', 'Agent', '项目', 'runtime'],
  enablePlanning: false,
  timeoutMs: 30000,
};
