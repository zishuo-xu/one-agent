import './load-env.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentLoop,
  config,
  ContextManager,
  createBuiltInTools,
  Sandbox,
  ToolRegistry,
  AgentLoopEvent,
  Message,
} from '@one-agent/agent-core';

const WORKSPACE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../workspace'
);

const sandbox = new Sandbox(WORKSPACE_ROOT);
const tools = new ToolRegistry();
tools.registerMany(createBuiltInTools(sandbox));

const WELCOME = `
🤖 One Agent CLI
Model: ${config.model}
Tools: ${tools.list().map((t) => t.name).join(', ')}
Workspace: ${sandbox.rootPath}
Type your message and press Enter. Use /exit or /quit to leave.
`;

function printEvent(event: AgentLoopEvent) {
  if (event.type === 'tool_call' && event.toolCall) {
    const args = JSON.stringify(event.toolCall.arguments);
    console.log(`[调用工具] ${event.toolCall.name}: ${args}`);
  } else if (event.type === 'tool_result' && event.toolResult) {
    const result = JSON.stringify(event.toolResult);
    console.log(`[工具结果] ${result}`);
  }
}

function printMessages(messages: Message[]) {
  for (const msg of messages) {
    const prefix = msg.role === 'system' ? '📋 system' :
                   msg.role === 'user' ? '👤 user' :
                   msg.role === 'assistant' ? '🤖 assistant' : '🔧 tool';
    console.log(`${prefix}: ${msg.content}`);
  }
}

export async function runRepl(): Promise<void> {
  console.log(WELCOME);

  const rl = readline.createInterface({ input, output });
  const contextManager = new ContextManager({
    systemPrompt: config.systemPrompt,
  });
  const agent = new AgentLoop({ tools, contextManager });
  let closed = false;

  rl.on('close', () => {
    closed = true;
  });

  while (!closed) {
    let userInput: string;
    try {
      userInput = await rl.question('You: ');
    } catch {
      break;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    if (trimmed === '/history') {
      console.log('\n--- History ---');
      printMessages(agent.getHistory());
      console.log('---\n');
      continue;
    }

    if (trimmed === '/context') {
      console.log('\n--- Context sent to model ---');
      printMessages(agent.getContext());
      console.log('---\n');
      continue;
    }

    try {
      const { reply, events } = await agent.chat(trimmed);
      for (const event of events) {
        printEvent(event);
      }
      console.log(`\nAgent: ${reply}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nError: ${message}\n`);
    }
  }

  console.log('Bye!');
  rl.close();
}

runRepl().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
