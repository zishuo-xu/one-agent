import './load-env.js';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import {
  AgentLoop,
  AgentLoopEvent,
  config,
  createBuiltInTools,
  Sandbox,
  ToolRegistry,
  ThreadStore,
  RunStore,
  MemoryStore,
  MemoryExtractor,
  TraceEventStore,
  getSharedConnection,
} from '@one-agent/agent-core';
import { WORKSPACE_ROOT } from './load-env.js';
import { printTraces } from './commands/traces.js';

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH ?? path.join(WORKSPACE_ROOT, 'data.db');

const COMMANDS = [
  '/history',
  '/context',
  '/reasoning',
  '/threads',
  '/runs',
  '/traces',
  '/thread',
  '/exit',
  '/quit',
];

function createAgent(
  threadId: string | undefined,
  memoryStore: MemoryStore,
  memoryExtractor: MemoryExtractor
) {
  const sandbox = new Sandbox(WORKSPACE_ROOT);
  const tools = new ToolRegistry();
  tools.registerMany(createBuiltInTools(sandbox));

  return new AgentLoop({
    tools,
    threadId,
    memoryStore,
    memoryExtractor,
  });
}

function parseArgs(): { threadId?: string; newThread: boolean } {
  const args = process.argv.slice(2);
  const threadIndex = args.indexOf('--thread');
  const threadId =
    threadIndex >= 0 && args[threadIndex + 1] ? args[threadIndex + 1] : undefined;
  const newThread = args.includes('--new-thread');
  return { threadId, newThread };
}

function truncateTitle(text: string, maxLength = 50): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

async function main() {
  const { threadId: argThreadId, newThread } = parseArgs();
  const db = getSharedConnection();
  const threadStore = new ThreadStore(db);
  const runStore = new RunStore(db);
  const memoryStore = new MemoryStore(db);
  const memoryExtractor = new MemoryExtractor();
  const traceEventStore = new TraceEventStore(db);

  let threadId: string;
  let title: string | null = null;

  if (argThreadId && !newThread) {
    const existing = threadStore.getById(argThreadId);
    if (existing) {
      threadId = existing.id;
      title = existing.title;
      console.log(`Resumed thread ${threadId}${title ? ` (${title})` : ''}`);
    } else {
      threadId = argThreadId;
      threadStore.create({ id: threadId });
      console.log(`Created new thread ${threadId} (requested thread not found)`);
    }
  } else {
    threadId = threadStore.create({}).id;
    console.log(`Created new thread ${threadId}`);
  }

  let agent = createAgent(threadId, memoryStore, memoryExtractor);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log('Type a message or a command. Commands: /history /context /reasoning /threads /runs /traces /thread <id> /exit');
  console.log(`Thread: ${threadId}`);

  while (true) {
    const input = await rl.question('> ');
    const trimmed = input.trim();

    if (!trimmed) continue;

    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log('Goodbye.');
      rl.close();
      break;
    }

    if (trimmed === '/history') {
      for (const message of agent.getHistory()) {
        console.log(`[${message.role}] ${message.content.slice(0, 200)}`);
      }
      continue;
    }

    if (trimmed === '/context') {
      for (const message of agent.getContext()) {
        console.log(`[${message.role}] ${message.content.slice(0, 200)}`);
      }
      continue;
    }

    if (trimmed === '/reasoning') {
      const chain = agent.getReasoningChain();
      for (const step of chain.getSteps()) {
        if (step.thought) console.log(`Thought: ${step.thought}`);
        if (step.action) console.log(`Action: ${step.action.name}(${JSON.stringify(step.action.arguments)})`);
        if (step.observation) console.log(`Observation: ${JSON.stringify(step.observation)}`);
        if (step.reflection) console.log(`Reflection: ${step.reflection}`);
        console.log('---');
      }
      continue;
    }

    if (trimmed === '/threads') {
      const threads = threadStore.list();
      for (const thread of threads) {
        const marker = thread.id === threadId ? ' *' : '';
        console.log(`${thread.id}${marker} ${thread.title ?? '(no title)'} - ${thread.updatedAt}`);
      }
      continue;
    }

    if (trimmed === '/runs') {
      const runs = runStore.getByThread(threadId);
      for (const run of runs) {
        console.log(`${run.id} ${run.status} ${run.startTime}${run.endTime ? ` -> ${run.endTime}` : ''}`);
      }
      continue;
    }

    if (trimmed === '/traces') {
      const traces = traceEventStore.getByThread(threadId);
      printTraces(traces);
      continue;
    }

    if (trimmed.startsWith('/traces ')) {
      const id = trimmed.slice('/traces '.length).trim();
      if (!id) {
        console.log('Usage: /traces <run-id>');
        continue;
      }
      const run = runStore.getById(id);
      if (!run) {
        console.log(`Run not found: ${id}`);
        continue;
      }
      const traces = traceEventStore.getByRun(id);
      printTraces(traces);
      continue;
    }

    if (trimmed.startsWith('/thread ')) {
      const id = trimmed.slice('/thread '.length).trim();
      if (!id) {
        console.log('Usage: /thread <id>');
        continue;
      }
      const existing = threadStore.getById(id);
      if (!existing) {
        console.log(`Thread not found: ${id}`);
        continue;
      }
      threadId = existing.id;
      title = existing.title;
      agent = createAgent(threadId, memoryStore, memoryExtractor);
      console.log(`Switched to thread ${threadId}${title ? ` (${title})` : ''}`);
      continue;
    }

    if (trimmed.startsWith('/')) {
      console.log(`Unknown command. Available: ${COMMANDS.join(', ')}`);
      continue;
    }

    try {
      if (!title) {
        title = truncateTitle(trimmed);
        threadStore.updateTitle(threadId, title);
      }

      const onEvent = (event: AgentLoopEvent) => {
        if (event.type === 'message_delta') {
          process.stdout.write(event.content);
        } else if (event.type === 'tool_call') {
          process.stdout.write(`\n[tool_call] ${event.toolCall.name}\n`);
        } else if (event.type === 'tool_result') {
          const status = event.toolResult.success ? 'ok' : 'failed';
          process.stdout.write(`[tool_result] ${status}\n`);
        } else if (event.type === 'thought') {
          process.stdout.write(`\n[thought] ${event.content.slice(0, 120)}\n`);
        } else if (event.type === 'reflection') {
          process.stdout.write(`\n[reflection] ${event.content.slice(0, 120)}\n`);
        } else if (event.type === 'plan') {
          process.stdout.write(`\n[plan] ${event.plan.steps.map((s) => s.description).join(' -> ')}\n`);
        }
      };

      agent.on('event', onEvent);
      const { reply } = await agent.chat(trimmed);
      agent.off('event', onEvent);
      process.stdout.write('\n');
      if (reply) {
        console.log(`\nAgent: ${reply}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
