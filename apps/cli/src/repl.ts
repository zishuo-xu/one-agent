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

export const WELCOME = `
🤖 One Agent CLI
Model: ${config.model}
Tools: ${tools.list().map((t) => t.name).join(', ')}
Workspace: ${sandbox.rootPath}
Type your message and press Enter. Use /exit or /quit to leave.
`;

export function printEvent(event: AgentLoopEvent) {
  if (event.type === 'plan') {
    console.log('\n[计划]');
    for (const step of event.plan.steps) {
      console.log(`${step.id}. ${step.description}`);
    }
    if (event.plan.reasoning) {
      console.log(`Reasoning: ${event.plan.reasoning}`);
    }
  } else if (event.type === 'thought') {
    console.log(`[思考] ${event.content}`);
  } else if (event.type === 'reflection') {
    console.log(`[反思] ${event.content}`);
  } else if (event.type === 'tool_call' && event.toolCall) {
    const args = JSON.stringify(event.toolCall.arguments);
    console.log(`[调用工具] ${event.toolCall.name}: ${args}`);
  } else if (event.type === 'tool_result' && event.toolResult) {
    const result = JSON.stringify(event.toolResult);
    console.log(`[工具结果] ${result}`);
  }
}

export function printMessages(messages: Message[]) {
  for (const msg of messages) {
    const prefix =
      msg.role === 'system'
        ? '📋 system'
        : msg.role === 'user'
          ? '👤 user'
          : msg.role === 'assistant'
            ? '🤖 assistant'
            : '🔧 tool';
    console.log(`${prefix}: ${msg.content}`);
  }
}

export interface ReplOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  question?: (prompt: string) => Promise<string>;
  onClose?: () => void;
}

export async function runRepl(options: ReplOptions = {}): Promise<void> {
  console.log(WELCOME);

  const rl = options.question
    ? ({ question: options.question, close: () => {} } as readline.Interface)
    : readline.createInterface({ input: options.input ?? input, output: options.output ?? output });

  const contextManager = new ContextManager({
    systemPrompt: config.systemPrompt,
  });
  const agent = new AgentLoop({ tools, contextManager });

  while (true) {
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
      options.onClose?.();
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

    if (trimmed === '/reasoning') {
      console.log('\n--- Reasoning chain ---');
      const chain = agent.getReasoningChain();
      const steps = chain.getSteps();
      if (steps.length > 0) {
        for (const step of steps) {
          if (step.thought) console.log(`Thought: ${step.thought}`);
          if (step.action) console.log(`Action: ${step.action.name}`);
          if (step.observation) console.log(`Observation: ${JSON.stringify(step.observation)}`);
          if (step.reflection) console.log(`Reflection: ${step.reflection}`);
          console.log('---');
        }
      } else {
        console.log('No reasoning chain yet.');
      }
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
  options.onClose?.();
}
