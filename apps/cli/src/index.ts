import './load-env.js';
import fs from 'node:fs';
import readline from 'node:readline';
import { createServer as createNetServer } from 'node:net';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import {
  AgentRuntime,
  config,
  RunStore,
  MessageStore,
  getSharedConnection,
} from '@one-agent/agent-core';
import { WORKSPACE_ROOT } from './load-env.js';
import { printTraces, printRunSummary } from './commands/traces.js';
import { formatContextDisplay } from './commands/context.js';
import { formatMemoryDetail, formatMemoryList, resolveMemory } from './commands/memory.js';
import { sanitizeTerminalText } from './output.js';
import { renderMarkdown } from './markdown.js';
import { HELP_TEXT, printHelp, printVersion, printStartup } from './help.js';
import { categorizeError, printError } from './errors.js';
import { createChatEventHandler } from './chat-events.js';
import { isUsableApiKey, parseArgs, resolveThread } from './args.js';
import {
  cyan,
  dim,
  formatDuration,
  formatRelativeTime,
  padEnd,
  shortId,
} from './format.js';

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH ?? path.join(WORKSPACE_ROOT, 'data.db');

const COMMANDS = [
  '/help',
  '/history',
  '/context',
  '/context --verbose',
  '/reasoning',
  '/memory',
  '/memory <id>',
  '/memory delete <id>',
  '/threads',
  '/runs',
  '/runs <run-id>',
  '/traces',
  '/traces <run-id>',
  '/traces <run-id> --verbose',
  '/resume <run-id>',
  '/thread <id>',
  '/exit',
  '/quit',
];

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
    '# Optional: per-request timeout in ms (default 30000)',
    '# OPENAI_TIMEOUT_MS=60000',
    '# Optional: context window token budget (default 4096)',
    '# MAX_CONTEXT_TOKENS=8192',
    '# Optional: recent message token budget (default 2048)',
    '# RECENT_TOKEN_BUDGET=4096',
    '# Optional: Tavily/Brave/DuckDuckGo search configuration',
    '# SEARCH_API_URL=',
    '# SEARCH_API_KEY=',
  ].join('\n');
  fs.writeFileSync(envPath, template, 'utf-8');
  console.log(`Created ${envPath}`);
  console.log('Please open it and set your OPENAI_API_KEY, then run one-agent again.');
}

function validateApiKey(): boolean {
  if (isUsableApiKey(process.env.OPENAI_API_KEY)) {
    return true;
  }
  console.error('Error: OPENAI_API_KEY is missing or still uses the template placeholder.');
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

function truncateTitle(text: string, maxLength = 50): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}...`;
}

function getFirstUserMessageSummary(messageStore: MessageStore, threadId: string): string {
  const messages = messageStore.getByThread(threadId);
  const firstUser = messages.find((m) => m.role === 'user');
  return firstUser ? truncateTitle(firstUser.content, 50) : '(no title)';
}

function printSeparator() {
  console.log('─'.repeat(60));
}

function printRecoveryHint(runStore: RunStore, threadId: string): void {
  const recoverable = runStore.getRecoverableByThread(threadId);
  if (recoverable.length === 0) return;
  console.log(cyan(`Detected ${recoverable.length} interrupted planning run(s).`));
  for (const run of recoverable) {
    console.log(dim(`  /resume ${shortId(run.id)}  (${run.checkpoint?.plan.steps.length ?? 0} plan steps)`));
  }
}

async function findAvailablePort(startPort = 3001, attempts = 20): Promise<number> {
  for (let port = startPort; port < startPort + attempts; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createNetServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`No available trace viewer port in ${startPort}-${startPort + attempts - 1}`);
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
  // Spinner frames redraw via carriage return; when stdout is not a TTY
  // (piped/redirected) they pollute the output, so stay a no-op there.
  const animated = Boolean(process.stdout.isTTY);

  const render = () => {
    process.stdout.write(`\r${frames[index]} ${currentLabel}...  `);
  };

  return {
    start: () => {
      if (interval || !animated) return;
      render();
      interval = setInterval(() => {
        index = (index + 1) % frames.length;
        render();
      }, 120);
    },
    stop: () => {
      if (!interval) {
        return;
      }
      clearInterval(interval);
      interval = null;
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
    },
    setLabel: (newLabel: string) => {
      currentLabel = newLabel;
    },
  };
}

async function main() {
  const { threadId: argThreadId, newThread, verbose, help, version, init, plan, trace } = parseArgs();

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
  const runtime = new AgentRuntime({ workspaceRoot: WORKSPACE_ROOT, db });
  const threadStore = runtime.stores.threads;
  const runStore = runtime.stores.runs;
  const messageStore = runtime.stores.messages;
  const memoryStore = runtime.stores.memories;
  const memoryConsolidator = runtime.memory;
  const traceEventStore = runtime.stores.traces;

  let threadId: string;
  let title: string | null = null;

  try {
    const resolution = resolveThread(
      { threadId: argThreadId, newThread, verbose, help, version, init, plan, trace },
      threadStore.list().map((t) => ({ id: t.id, title: t.title })),
      (id) => Boolean(threadStore.getById(id)),
      (id) => threadStore.create(id ? { id } : {}).id,
    );
    threadId = resolution.threadId;
    const resolved = threadStore.getById(threadId);
    title = resolved?.title ?? null;
    printStartup(threadId, resolution.mode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let agent = runtime.createAgent({ threadId, planning: plan });
  printRecoveryHint(runStore, threadId);
  void memoryConsolidator.recoverUnextracted();

  // Optionally start the trace web viewer in the background.
  let traceProcess: import('node:child_process').ChildProcess | null = null;
  if (trace) {
    try {
      const { spawn } = await import('node:child_process');
      const fs = await import('node:fs');
      const traceWebPath = path.resolve(new URL('../../trace-web/dist/index.js', import.meta.url).pathname);
      if (fs.existsSync(traceWebPath)) {
        const tracePort = await findAvailablePort();
        traceProcess = spawn('node', [
          traceWebPath,
          '--port', String(tracePort),
          '--host', '127.0.0.1',
          '--workspace', WORKSPACE_ROOT,
        ], {
          stdio: 'ignore',
          detached: false,
          env: {
            ...process.env,
            DATABASE_PATH: process.env.DATABASE_PATH ?? path.join(WORKSPACE_ROOT, 'data.db'),
          },
        });
        console.log(cyan(`Trace viewer: http://127.0.0.1:${tracePort}`));
        console.log(dim(`Trace database: ${process.env.DATABASE_PATH}`));
      } else {
        console.warn(dim('Trace viewer not found. Run "pnpm build" first.'));
      }
    } catch (err) {
      console.warn(dim(`Trace viewer failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const inputQueue: string[] = [];
  let pendingInput: ((input: string | null) => void) | null = null;
  let inputClosed = false;

  rl.on('line', (line) => {
    if (pendingInput) {
      const resolve = pendingInput;
      pendingInput = null;
      resolve(line);
      return;
    }
    inputQueue.push(line);
  });

  rl.on('close', () => {
    inputClosed = true;
    if (pendingInput) {
      const resolve = pendingInput;
      pendingInput = null;
      resolve(null);
    }
  });

  const readInput = (): Promise<string | null> => {
    process.stdout.write('> ');
    const queued = inputQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (inputClosed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      pendingInput = resolve;
    });
  };

  let abortController: AbortController | null = null;
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (abortController && sigintCount === 1) {
      console.log('\nInterrupting current turn... press Ctrl-C again to force quit.');
      abortController.abort();
      abortController = null;
    } else if (!abortController && sigintCount === 1) {
      console.log('\nClosing session and consolidating memory...');
      rl.close();
      if (traceProcess) traceProcess.kill();
    } else {
      process.exit(0);
    }
  });

  while (true) {
    const input = await readInput();
    if (input === null) {
      break;
    }
    const trimmed = input.trim();

    if (!trimmed) continue;

    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log('Goodbye.');
      rl.close();
      if (traceProcess) traceProcess.kill();
      break;
    }

    if (trimmed === '/help') {
      printHelp();
      continue;
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

    if (trimmed === '/context' || trimmed === '/context --verbose') {
      const context = agent.getContext();
      const info = agent.getContextInfo();
      const lines = formatContextDisplay({
        context,
        userFacingHistory: agent.getUserFacingHistory(),
        info,
        verbose: trimmed.endsWith('--verbose'),
      });
      for (const line of lines) {
        console.log(line);
      }
      continue;
    }

    if (trimmed === '/reasoning') {
      const chain = agent.getReasoningChain();
      const steps = chain.getSteps();
      if (steps.length === 0) {
        console.log('No PlanningLoop reasoning for the current turn.');
        console.log('Model reasoning is recorded in Trace; use /traces to inspect it.');
      } else {
        const thoughts = steps.filter((s) => s.thought).length;
        const actions = steps.filter((s) => s.action).length;
        const reflections = steps.filter((s) => s.reflection).length;
        console.log(`Planning reasoning: ${steps.length} step(s), ${thoughts} thought(s), ${actions} action(s), ${reflections} reflection(s).`);
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

    if (trimmed === '/memory') {
      for (const line of formatMemoryList(memoryStore.list({ status: 'active' }))) {
        console.log(line);
      }
      continue;
    }

    if (trimmed.startsWith('/memory delete ')) {
      const id = trimmed.slice('/memory delete '.length).trim();
      const memory = resolveMemory(memoryStore.list(), id);
      if (!memory) {
        console.log(`Memory not found or prefix is ambiguous: ${id}`);
      } else {
        memoryStore.deleteById(memory.id);
        console.log(`Deleted memory ${shortId(memory.id)}.`);
      }
      continue;
    }

    if (trimmed.startsWith('/memory ')) {
      const id = trimmed.slice('/memory '.length).trim();
      const memory = resolveMemory(memoryStore.list(), id);
      if (!memory) {
        console.log(`Memory not found or prefix is ambiguous: ${id}`);
      } else {
        for (const line of formatMemoryDetail(memory)) console.log(line);
      }
      continue;
    }

    if (trimmed === '/threads') {
      const threads = threadStore.list();
      const maxTitleWidth = 28;
      for (const thread of threads) {
        const marker = thread.id === threadId ? '* ' : '  ';
        const displayTitle = thread.title
          ? truncateTitle(thread.title, maxTitleWidth)
          : truncateTitle(getFirstUserMessageSummary(messageStore, thread.id), maxTitleWidth);
        const id = shortId(thread.id);
        const relTime = formatRelativeTime(thread.updatedAt);
        console.log(`${marker}${padEnd(id, 10)}${padEnd(displayTitle, maxTitleWidth + 2)}${relTime}`);
      }
      continue;
    }

    if (trimmed === '/runs') {
      const runs = runStore.getByThread(threadId);
      if (runs.length === 0) {
        console.log('No runs in this thread.');
      } else {
        for (const run of runs) {
          printRunSummary({
            id: run.id,
            status: run.status,
            startTime: run.startTime,
            endTime: run.endTime,
            title: threadStore.getById(run.threadId)?.title,
          });
        }
      }
      continue;
    }

    if (trimmed.startsWith('/runs ')) {
      const id = trimmed.slice('/runs '.length).trim();
      if (!id) {
        console.log('Usage: /runs <run-id>');
        continue;
      }
      const run = runStore.getById(id) ?? runStore.getByThread(threadId).find((r) => r.id.startsWith(id));
      if (!run) {
        console.log(`Run not found: ${id}`);
        continue;
      }
      printRunSummary({
        id: run.id,
        status: run.status,
        startTime: run.startTime,
        endTime: run.endTime,
        title: threadStore.getById(run.threadId)?.title,
      });
      const traces = traceEventStore.getByRun(run.id);
      printTraces(traces, { limit: 20 });
      continue;
    }

    if (trimmed === '/traces') {
      const runs = runStore.getByThread(threadId);
      const latestRun = runs[0];
      if (!latestRun) {
        console.log('No runs in this thread.');
      } else {
        const traces = traceEventStore.getByRun(latestRun.id);
        printTraces(traces, { limit: 20 });
      }
      continue;
    }

    if (trimmed.startsWith('/traces ')) {
      const rest = trimmed.slice('/traces '.length).trim();
      if (!rest) {
        console.log('Usage: /traces <run-id> [--verbose]');
        continue;
      }
      const parts = rest.split(/\s+/);
      const id = parts[0];
      const verboseFlag = parts.includes('--verbose');
      const run = runStore.getById(id) ?? runStore.getByThread(threadId).find((r) => r.id.startsWith(id));
      if (!run) {
        console.log(`Run not found: ${id}`);
        continue;
      }
      const traces = traceEventStore.getByRun(run.id);
      printTraces(traces, { limit: verboseFlag ? undefined : 20, verbose: verboseFlag });
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
      const leavingThreadId = threadId;
      threadId = existing.id;
      title = existing.title;
      agent = runtime.createAgent({ threadId, planning: plan });
      void memoryConsolidator.consolidateThread(leavingThreadId);
      console.log(`Switched to thread ${threadId}${title ? ` (${title})` : ''}`);
      printRecoveryHint(runStore, threadId);
      continue;
    }

    if (trimmed === '/resume') {
      console.log('Usage: /resume <run-id>');
      printRecoveryHint(runStore, threadId);
      continue;
    }

    if (trimmed.startsWith('/resume ')) {
      const id = trimmed.slice('/resume '.length).trim();
      const run = runStore.getById(id) ?? runStore
        .getRecoverableByThread(threadId)
        .find((candidate) => candidate.id.startsWith(id));
      if (!run || run.threadId !== threadId) {
        console.log(`Recoverable run not found: ${id}`);
        continue;
      }

      printSeparator();
      sigintCount = 0;
      abortController = new AbortController();
      const progress = createProgressIndicator(`正在恢复 ${shortId(run.id)}…`);
      progress.start();
      const { handler: onEvent, result: timeline } = createChatEventHandler({
        onDelta: (text) => process.stdout.write(text),
        onReasoning: (text) => process.stdout.write(dim(text)),
        onInfo: (text) => process.stdout.write(text),
        progress,
        verbose,
      });
      agent.on('event', onEvent);
      try {
        const result = await agent.resumeRun(run.id, abortController.signal);
        const renderable = sanitizeTerminalText(result.reply).trim();
        process.stdout.write('\n');
        if (!timeline.hasStreamedLive && renderable) {
          console.log(`\n${renderMarkdown(renderable)}`);
        }
        console.log(dim(`Recovered as run ${shortId(result.runId ?? '')}.`));
      } catch (error) {
        printError(categorizeError(error, run.id, verbose), verbose);
      } finally {
        agent.off('event', onEvent);
        progress.stop();
        abortController = null;
      }
      printSeparator();
      continue;
    }

    if (trimmed.startsWith('/')) {
      console.log(`Unknown command. Available: ${COMMANDS.join(', ')}`);
      console.log('Run "one-agent --help" for details.');
      continue;
    }

    let runIdFromError: string | undefined;
    try {
      if (!title) {
        title = truncateTitle(trimmed);
        threadStore.updateTitle(threadId, title);
      }

      printSeparator();

      sigintCount = 0;
      abortController = new AbortController();

      let currentRunId: string | undefined;

      const progress = createProgressIndicator(`正在请求 ${config.model}…`);
      progress.start();
      const startTime = Date.now();

      const { handler: onEvent, result: timeline } = createChatEventHandler({
        onDelta: (text) => process.stdout.write(text),
        onReasoning: (text) => process.stdout.write(dim(text)),
        onInfo: (text) => process.stdout.write(text),
        progress,
        verbose,
      });

      agent.on('event', onEvent);
      let runResult: { reply: string; runId?: string; tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
      try {
        runResult = await agent.chat(trimmed, abortController.signal);
      } catch (error) {
        // Try to find the latest run in this thread for error hints.
        const latestRun = runStore.getByThread(threadId)[0];
        runIdFromError = latestRun?.id;
        throw error;
      } finally {
        // Always release the per-turn listener and spinner, even on the error
        // path — otherwise a stale onEvent stays attached to the agent and the
        // progress indicator keeps spinning across the next turn.
        agent.off('event', onEvent);
        progress.stop();
      }
      abortController = null;
      currentRunId = runResult.runId;

      const ttfa = timeline.firstDeltaTime > 0 ? timeline.firstDeltaTime - startTime : 0;
      const answerDuration =
        timeline.answerStartTime > 0 && timeline.answerEndTime > 0
          ? timeline.answerEndTime - timeline.answerStartTime
          : 0;
      const toolDuration =
        timeline.toolStartTime > 0 && timeline.toolEndTime > 0
          ? timeline.toolEndTime - timeline.toolStartTime
          : 0;

      const reply = runResult.reply;
      const renderable = sanitizeTerminalText(reply).trim();

      process.stdout.write('\n');
      if (timeline.hasStreamedLive) {
        // Tokens were printed live; no re-render needed.
        if (timeline.streamedContent.trim().length === 0) {
          console.log('[Model returned an empty response]');
        }
      } else if (renderable.length > 0) {
        // Non-streamed reply: render Markdown once at the end.
        const rendered = renderMarkdown(renderable);
        console.log(`\n${rendered}`);
      } else if (timeline.streamedContent.trim().length === 0) {
        console.log('\n[Model returned an empty response]');
      }

      const parts: string[] = [];
      if (ttfa > 0) parts.push(`首字 ${formatDuration(ttfa)}`);
      if (answerDuration > 0) parts.push(`回答 ${formatDuration(answerDuration)}`);
      if (toolDuration > 0) parts.push(`工具 ${formatDuration(toolDuration)}`);
      const usage = runResult.tokenUsage;
      if (usage) {
        parts.push(`输入 ${usage.promptTokens} tokens`);
        parts.push(`输出 ${usage.completionTokens} tokens`);
      }
      if (verbose) parts.push('记忆：切换或退出会话时整理');
      if (parts.length > 0) {
        console.log(`\n(${parts.join(' · ')})`);
      }

      if (!renderable && !timeline.hasStreamedLive && currentRunId) {
        console.log(dim(`可执行 /runs 或 /traces ${shortId(currentRunId)} 查看详情。`));
      }

      printSeparator();
    } catch (error) {
      abortController = null;
      if (error instanceof Error && error.message === 'AgentLoop was cancelled') {
        console.log('\nTurn cancelled.');
      } else {
        const latestRun = runStore.getByThread(threadId)[0];
        const categorized = categorizeError(error, runIdFromError ?? latestRun?.id, verbose);
        printError(categorized, verbose);
      }
      printSeparator();
    }
  }

  await memoryConsolidator.consolidateThread(threadId);
  if (traceProcess) traceProcess.kill();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
