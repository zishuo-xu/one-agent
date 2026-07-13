import './load-env.js';
import fs from 'node:fs';
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
  '/traces <run-id>',
  '/thread <id>',
  '/exit',
  '/quit',
];

const HELP_TEXT = `
Usage: one-agent [options]

Options:
  --help, -h          Show this help message
  --version, -v       Show version
  --init              Create a .env template in the workspace
  --new-thread        Start a new thread
  --thread <id>       Resume a specific thread
  --plan              Enable planning mode for multi-step tool tasks
  --verbose           Show internal thoughts, plans, and reflections

Interactive commands:
  /history            Show your messages and the assistant replies
  /context            Show a summary of the current conversation context
  /reasoning          Show the agent's reasoning trace for the last turn
  /threads            List all threads
  /runs               List runs in the current thread
  /traces             List traces for the current thread
  /traces <run-id>    Show traces for a specific run
  /thread <id>        Switch to another thread
  /exit, /quit        Exit the CLI
`;

function printHelp(): void {
  console.log(HELP_TEXT.trim());
}

function printVersion(): void {
  console.log('one-agent 0.0.1');
}

function createEnvTemplate(): void {
  const envPath = path.join(WORKSPACE_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    console.log(`A .env file already exists at ${envPath}.`);
    console.log('Please edit it directly if you need to update your keys.');
    return;
  }
  const template = [
    '# one-agent configuration',
    'OPENAI_API_KEY=your-api-key',
    'OPENAI_BASE_URL=https://api.openai.com/v1',
    'OPENAI_MODEL=gpt-3.5-turbo',
    '# Optional: Tavily/Brave/DuckDuckGo search configuration',
    '# SEARCH_API_URL=',
    '# SEARCH_API_KEY=',
  ].join('\n');
  fs.writeFileSync(envPath, template, 'utf-8');
  console.log(`Created ${envPath}`);
  console.log('Please open it and set your OPENAI_API_KEY, then run one-agent again.');
}

function validateApiKey(): boolean {
  if (process.env.OPENAI_API_KEY) {
    return true;
  }
  console.error('Error: OPENAI_API_KEY is not set.');
  console.error(`Workspace: ${WORKSPACE_ROOT}`);
  console.error('');
  console.error('To fix this, either:');
  console.error(`  1. Run "one-agent --init" to create a .env template in ${WORKSPACE_ROOT}, then edit it.`);
  console.error(`  2. Create ${path.join(WORKSPACE_ROOT, '.env')} manually with OPENAI_API_KEY=...`);
  console.error('  3. Set OPENAI_API_KEY as an environment variable.');
  console.error('');
  console.error('Run "one-agent --help" for more options.');
  return false;
}

function createAgent(
  threadId: string | undefined,
  memoryStore: MemoryStore,
  memoryExtractor: MemoryExtractor,
  enablePlanning = false
) {
  const sandbox = new Sandbox(WORKSPACE_ROOT);
  const tools = new ToolRegistry();
  tools.registerMany(createBuiltInTools(sandbox));

  return new AgentLoop({
    tools,
    threadId,
    memoryStore,
    memoryExtractor,
    enablePlanning,
  });
}

function parseArgs(): {
  threadId?: string;
  newThread: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  init: boolean;
  plan: boolean;
} {
  const args = process.argv.slice(2);
  const threadIndex = args.indexOf('--thread');
  const threadId =
    threadIndex >= 0 && args[threadIndex + 1] ? args[threadIndex + 1] : undefined;
  const newThread = args.includes('--new-thread');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const help = args.includes('--help') || args.includes('-h');
  const version = args.includes('--version');
  const init = args.includes('--init');
  const plan = args.includes('--plan');
  return { threadId, newThread, verbose, help, version, init, plan };
}

function truncateTitle(text: string, maxLength = 50): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

function formatToolResultSummary(toolResult: { success: boolean; data?: unknown; error?: string }): string {
  if (!toolResult.success) {
    return toolResult.error ?? 'failed';
  }

  const data = toolResult.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    return 'ok';
  }

  if (typeof data.results === 'object' && Array.isArray(data.results)) {
    const count = data.results.length;
    return count > 0 ? `found ${count} result(s)` : 'no results';
  }

  return 'ok';
}

function printSeparator() {
  console.log('─'.repeat(60));
}

function createProgressIndicator(label = 'Thinking'): {
  start: () => void;
  stop: () => void;
  setLabel: (newLabel: string) => void;
} {
  let interval: NodeJS.Timeout | null = null;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let index = 0;
  let currentLabel = label;

  const render = () => {
    process.stdout.write(`\r${frames[index]} ${currentLabel}...  `);
  };

  return {
    start: () => {
      if (interval) return;
      render();
      interval = setInterval(() => {
        index = (index + 1) % frames.length;
        render();
      }, 120);
    },
    stop: () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
    },
    setLabel: (newLabel: string) => {
      currentLabel = newLabel;
    },
  };
}

async function main() {
  const { threadId: argThreadId, newThread, verbose, help, version, init, plan } = parseArgs();

  if (help) {
    printHelp();
    return;
  }

  if (version) {
    printVersion();
    return;
  }

  if (init) {
    createEnvTemplate();
    return;
  }

  if (!validateApiKey()) {
    process.exit(1);
  }

  if (!process.env.OPENAI_BASE_URL) {
    console.warn(
      'Warning: OPENAI_BASE_URL is not set. The client will use the default OpenAI endpoint.'
    );
  }

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

  let agent = createAgent(threadId, memoryStore, memoryExtractor, plan);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log();
  console.log('Commands:');
  console.log('  /history          your messages and assistant replies');
  console.log('  /context          current conversation context summary');
  console.log('  /reasoning        reasoning trace from the last turn');
  console.log('  /threads          list all threads');
  console.log('  /runs             list runs in this thread');
  console.log('  /traces           list traces in this thread');
  console.log('  /traces <run-id>  traces for a specific run');
  console.log('  /thread <id>      switch to another thread');
  console.log('  /exit             quit');
  console.log('  Use --verbose to show internal thoughts, plans, and reflections.');
  console.log('  Use --plan to enable multi-step planning mode.');
  console.log(`Thread: ${threadId}`);
  console.log();

  let abortController: AbortController | null = null;
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (abortController && sigintCount === 1) {
      console.log('\nInterrupting current turn... press Ctrl-C again to force quit.');
      abortController.abort();
      abortController = null;
    } else {
      process.exit(0);
    }
  });

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
      const history = agent.getUserFacingHistory();
      if (history.length === 0) {
        console.log('No messages yet.');
      } else {
        for (const message of history) {
          const prefix = message.role === 'user' ? 'You' : 'Assistant';
          console.log(`${prefix}: ${message.content.slice(0, 400)}`);
        }
      }
      continue;
    }

    if (trimmed === '/context') {
      const context = agent.getContext();
      const nonSystem = context.filter((m) => m.role !== 'system');
      const summary = context.find((m) => m.role === 'system' && m.content.startsWith('Earlier conversation summary:'));
      const memory = context.find((m) => m.role === 'system' && m.content.startsWith('Relevant context from past conversations:'));
      console.log(`Context has ${nonSystem.length} recent message(s).`);
      if (summary) {
        console.log(`Summary: ${summary.content.slice(0, 200)}`);
      }
      if (memory) {
        console.log(`Memory: ${memory.content.slice(0, 200)}`);
      }
      if (nonSystem.length > 0) {
        console.log('Recent messages:');
        for (const message of nonSystem.slice(-4)) {
          const prefix = message.role === 'user' ? 'You' : 'Assistant';
          console.log(`  ${prefix}: ${message.content.slice(0, 200)}`);
        }
      }
      continue;
    }

    if (trimmed === '/reasoning') {
      const chain = agent.getReasoningChain();
      const steps = chain.getSteps();
      if (steps.length === 0) {
        console.log('No reasoning trace for the current turn.');
      } else {
        const thoughts = steps.filter((s) => s.thought).length;
        const actions = steps.filter((s) => s.action).length;
        const reflections = steps.filter((s) => s.reflection).length;
        console.log(`Reasoning trace: ${steps.length} step(s), ${thoughts} thought(s), ${actions} action(s), ${reflections} reflection(s).`);
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          console.log(`Step ${i + 1}:`);
          if (step.planStepId) console.log(`  planStepId: ${step.planStepId}`);
          if (step.thought) console.log(`  thought: ${step.thought.slice(0, 120)}`);
          if (step.action) console.log(`  action: ${step.action.name}(${JSON.stringify(step.action.arguments)})`);
          if (step.observation) console.log(`  observation: ${JSON.stringify(step.observation).slice(0, 120)}`);
          if (step.reflection) console.log(`  reflection: ${step.reflection.slice(0, 120)}`);
          if (step.failureAnalysis) {
            console.log(`  failure: ${step.failureAnalysis.category} - ${step.failureAnalysis.rootCause?.slice(0, 120)}`);
          }
        }
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

    if (trimmed === '/thread') {
      console.log('Usage: /thread <id>');
      console.log('Use /threads to see available thread IDs.');
      continue;
    }

    if (trimmed.startsWith('/thread ')) {
      const id = trimmed.slice('/thread '.length).trim();
      if (!id) {
        console.log('Usage: /thread <id>');
        console.log('Use /threads to see available thread IDs.');
        continue;
      }
      const existing = threadStore.getById(id);
      if (!existing) {
        console.log(`Thread not found: ${id}`);
        continue;
      }
      threadId = existing.id;
      title = existing.title;
      agent = createAgent(threadId, memoryStore, memoryExtractor, plan);
      console.log(`Switched to thread ${threadId}${title ? ` (${title})` : ''}`);
      continue;
    }

    if (trimmed.startsWith('/')) {
      console.log(`Unknown command. Available: ${COMMANDS.join(', ')}`);
      console.log('Run "one-agent --help" for details.');
      continue;
    }

    try {
      if (!title) {
        title = truncateTitle(trimmed);
        threadStore.updateTitle(threadId, title);
      }

      printSeparator();

      sigintCount = 0;
      abortController = new AbortController();

      let stage: 'planning' | 'tool' | 'answer' = 'planning';
      let hasStreamedMessage = false;
      let hasEvents = false;
      const progress = createProgressIndicator('Planning');
      progress.start();
      const startTime = Date.now();

      const onEvent = (event: AgentLoopEvent) => {
        if (!hasEvents) {
          hasEvents = true;
        }

        if (event.type === 'plan') {
          stage = 'tool';
          progress.setLabel('Working');
          if (verbose) {
            process.stdout.write(`\n[plan] ${event.plan.steps.map((s) => s.description).join(' -> ')}\n`);
          }
        } else if (event.type === 'tool_call') {
          stage = 'tool';
          progress.setLabel('Working');
          process.stdout.write(`\n[tool_call] ${event.toolCall.name}\n`);
        } else if (event.type === 'tool_result') {
          const summary = formatToolResultSummary(event.toolResult);
          process.stdout.write(`[tool_result] ${summary}\n`);
        } else if (event.type === 'thought' && verbose) {
          process.stdout.write(`\n[thought] ${event.content.slice(0, 120)}\n`);
        } else if (event.type === 'reflection') {
          stage = 'planning';
          progress.setLabel('Re-planning');
          if (verbose) {
            process.stdout.write(`\n[reflection] ${event.content.slice(0, 120)}\n`);
          }
        } else if (event.type === 'message_delta') {
          if (stage !== 'answer') {
            stage = 'answer';
            progress.setLabel('Answering');
          }
          hasStreamedMessage = true;
          progress.stop();
          process.stdout.write(event.content);
        } else if (event.type === 'message') {
          progress.stop();
          if (!hasStreamedMessage && event.content) {
            console.log(`\n${event.content}`);
          }
        }
      };

      agent.on('event', onEvent);
      const { reply } = await agent.chat(trimmed, abortController.signal);
      agent.off('event', onEvent);
      progress.stop();
      abortController = null;

      const elapsed = Date.now() - startTime;
      process.stdout.write('\n');
      if (reply && !hasStreamedMessage) {
        console.log(`\n${reply}`);
      } else if (!reply && !hasStreamedMessage) {
        console.log('\n[Model returned an empty response]');
      }
      console.log(`\n(${elapsed}ms)`);

      printSeparator();
    } catch (error) {
      abortController = null;
      if (error instanceof Error && error.message === 'AgentLoop was cancelled') {
        console.log('\nTurn cancelled.');
      } else {
        console.error('Error:', error instanceof Error ? error.message : String(error));
      }
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
