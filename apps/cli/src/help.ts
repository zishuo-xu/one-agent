import { bold, dim, cyan } from './format.js';

export const HELP_TEXT = `
${bold('Usage')}:
  one-agent [options]
  one-agent trace [--workspace <dir>]

${bold('Options')}:
  --help, -h          Show this help message
  --version, -v       Show version
  --init              Create a .env template in the workspace
  --new               Start a new thread (do not resume the most recent one)
  --new-thread        Alias of --new
  --thread <id>       Resume a specific thread
  --workspace <dir>   Use the given directory as the agent workspace
  --loop <mode>       Execution strategy: auto (default), simple, or planning
  --verbose           Show model reasoning, internal thoughts, plans, and reflections

${bold('Commands')}:
  trace               Start the read-only Trace Viewer without starting chat

${bold('Compatibility aliases')}:
  --plan              Deprecated alias for --loop planning
  --plan-auto         Deprecated alias for --loop auto
  --trace             Deprecated: start Trace Viewer together with chat

${bold('REPL commands')}:
  /help               Show this command list
  /history            Show your messages and assistant replies
  /context            Show a summary of the current conversation context
  /context --verbose  Include recent internal tool/context messages
  /reasoning          Show PlanningLoop reasoning for the last turn
  /memory             List active long-term memories
  /memory <id>        Show memory source, scope, confidence, and lifecycle
  /memory delete <id> Permanently delete a memory
  /threads            List all threads
  /runs               List runs in the current thread
  /runs <run-id>      Show details for a specific run
  /traces             Show traces for the most recent run
  /traces <run-id>    Show traces for a specific run
  /traces <run-id> --verbose  Show full trace JSON
  /resume <run-id>    Resume an interrupted PlanningLoop run
  /cancel             Cancel the task currently waiting for your answer
  /thread <id>        Switch to another thread
  /exit, /quit        Exit the CLI

${dim('Without --thread/--new, the most recent thread is resumed automatically.')}
${dim('Model reasoning is always recorded in Trace; use --verbose to also show it live.')}
${dim('The default --loop auto sends simple tasks directly and plans only complex tasks.')}
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
