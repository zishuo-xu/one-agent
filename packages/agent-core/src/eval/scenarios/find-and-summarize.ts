import { EvalTask } from '../types.js';

export const findAndSummarizeTask: EvalTask = {
  id: 'find-and-summarize',
  name: '查看并总结代码',
  description: 'Agent 读取指定代码文件并说明其功能',
  prompt: '请帮我看看 src/index.ts 是做什么的，并简要说明',
  initialWorkspace: {
    'src/index.ts': `import { AgentLoop } from './agents/AgentLoop.js';

async function main() {
  const agent = new AgentLoop();
  const { reply } = await agent.chat('你好');
  console.log(reply);
}

main();
`,
  },
  requiredTools: [{ name: 'read_file', arguments: { path: 'src/index.ts' } }],
  finalAnswerContains: ['AgentLoop', 'agent', '聊天', 'main', '回复', 'console'],
  enablePlanning: false,
  timeoutMs: 30000,
};
