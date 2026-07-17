import { bold, dim, cyan } from './format.js';

export const HELP_TEXT = `
${bold('Usage')}: one-agent [options]

${bold('Options')}:
  --help, -h          Show this help message
  --version, -v       Show version
  --init              Create a .env template in the workspace
  --new               Start a new thread (do not resume the most recent one)
  --new-thread        Alias of --new
  --thread <id>       Resume a specific thread
  --workspace <dir>   Use the given directory as the agent workspace
  --plan              Enable planning mode for multi-step tool tasks
  --plan-auto         Let the agent decide per message whether to plan
  --verbose           Show internal thoughts, plans, and reflections
  --trace             Start the trace web viewer at http://127.0.0.1:3001

${bold('REPL commands')}:
  /help               Show this command list
  /history            Show your messages and assistant replies
  /context            Show a summary of the current conversation context
  /reasoning          Show the agent's reasoning trace for the last turn
  /threads            List all threads
  /runs               List runs in the current thread
  /runs <run-id>      Show details for a specific run
  /traces             Show traces for the most recent run
  /traces <run-id>    Show traces for a specific run
  /traces <run-id> --verbose  Show full trace JSON
  /resume <run-id>    Resume an interrupted PlanningLoop run
  /thread <id>        Switch to another thread
  /exit, /quit        Exit the CLI

${dim('Without --thread/--new, the most recent thread is resumed automatically.')}
${dim('Use --verbose to show internal thoughts, plans, and reflections.')}
${dim('Use --plan to enable multi-step planning mode, or --plan-auto to let the agent decide.')}
`.trim();

export function printHelp(): void {
  console.log(HELP_TEXT);
}

export function printVersion(): void {
  console.log('one-agent 0.0.1');
}

export function printStartup(threadId: string, mode: 'created' | 'resumed' = 'created'): void {
  const verb = mode === 'resumed' ? '已恢复会话' : '已创建会话';
  console.log(`${verb} ${cyan(threadId.slice(0, 8))}`);
  console.log(dim('输入消息开始对话；输入 /help 查看命令，/exit 退出。'));
}
