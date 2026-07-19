import './load-config.js';
import fs from 'node:fs';
import readline from 'node:readline';
import { createServer as createNetServer } from 'node:net';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import {
  AgentRuntime,
  config,
  createDefaultSystemConfig,
  RunStore,
  TraceEventStore,
  MessageStore,
  getSharedConnection,
} from '@one-agent/agent-core';
import type { AgentRun, AgentRunResult, RunCheckpoint } from '@one-agent/agent-core';
import { CONFIG_PATH, WORKSPACE_ROOT } from './load-config.js';
import { printTraces, printRunSummary } from './commands/traces.js';
import { formatContextDisplay } from './commands/context.js';
import { formatMemoryDetail, formatMemoryList, resolveMemory } from './commands/memory.js';
import { formatHistoryContent, sanitizeTerminalText } from './output.js';
import { renderMarkdown } from './markdown.js';
import { HELP_TEXT, printHelp, printVersion, printStartup } from './help.js';
import { categorizeError, printError } from './errors.js';
import { createChatEventHandler } from './chat-events.js';
import { isUsableApiKey, parseArgs, resolveThread, toPlanningOption } from './args.js';
import {
  cyan,
  dim,
  formatDuration,
  formatRelativeTime,
  padEnd,
  shortId,
} from './format.js';

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
  '/cancel',
  '/thread <id>',
  '/exit',
  '/quit',
];

function parseLegacyEnv(filePath: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries[match[1]] = value;
  }
  return entries;
}

function numericValue(values: Record<string, string>, key: string): number | undefined {
  if (!values[key]) return undefined;
  const parsed = Number(values[key]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function applyLegacyConfig(template: ReturnType<typeof createDefaultSystemConfig>, values: Record<string, string>): void {
  const anthropic = values.MODEL_PROVIDER === 'anthropic';
  template.model.provider = anthropic ? 'anthropic' : 'openai-compatible';
  template.model.apiKey = anthropic
    ? values.ANTHROPIC_API_KEY ?? values.OPENAI_API_KEY ?? 'your-api-key'
    : values.OPENAI_API_KEY ?? 'your-api-key';
  template.model.baseUrl = anthropic ? values.ANTHROPIC_BASE_URL : values.OPENAI_BASE_URL;
  template.model.model = anthropic
    ? values.ANTHROPIC_MODEL ?? template.model.model
    : values.OPENAI_MODEL ?? template.model.model;
  template.model.maxTokens = numericValue(values, 'ANTHROPIC_MAX_TOKENS') ?? template.model.maxTokens;
  template.model.timeoutMs = numericValue(values, 'MODEL_TIMEOUT_MS')
    ?? numericValue(values, 'OPENAI_TIMEOUT_MS')
    ?? template.model.timeoutMs;
  template.model.planningModel = values.PLANNING_MODEL;
  template.model.utilityModel = values.UTILITY_MODEL;

  const fallbackProvider = values.FALLBACK_MODEL_PROVIDER
    ?? (values.OPENAI_FALLBACK_BASE_URL ? 'openai-compatible' : undefined);
  if (fallbackProvider) {
    template.model.fallback = {
      provider: fallbackProvider === 'anthropic' ? 'anthropic' : 'openai-compatible',
      baseUrl: values.FALLBACK_BASE_URL
        ?? (fallbackProvider === 'anthropic' ? values.ANTHROPIC_FALLBACK_BASE_URL : values.OPENAI_FALLBACK_BASE_URL),
      apiKey: values.FALLBACK_API_KEY
        ?? (fallbackProvider === 'anthropic' ? values.ANTHROPIC_FALLBACK_API_KEY : values.OPENAI_FALLBACK_API_KEY)
        ?? template.model.apiKey,
      model: values.FALLBACK_MODEL ?? values.OPENAI_FALLBACK_MODEL ?? template.model.model,
      maxTokens: numericValue(values, 'FALLBACK_MAX_TOKENS')
        ?? numericValue(values, 'ANTHROPIC_FALLBACK_MAX_TOKENS')
        ?? 4096,
    };
  }

  template.runtime.systemPrompt = values.SYSTEM_PROMPT ?? template.runtime.systemPrompt;
  template.context.maxTokens = numericValue(values, 'MAX_CONTEXT_TOKENS') ?? template.context.maxTokens;
  template.context.recentTokenBudget = numericValue(values, 'RECENT_TOKEN_BUDGET') ?? template.context.recentTokenBudget;
  template.tools.disabled = values.DISABLED_TOOLS?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
  template.tools.search.apiUrl = values.SEARCH_API_URL;
  template.tools.search.apiKey = values.SEARCH_API_KEY;
  if (values.TRACE_CONTENT === 'metadata' || values.TRACE_CONTENT === 'full') {
    template.trace.contentMode = values.TRACE_CONTENT;
  }
  template.storage.databasePath = values.DATABASE_PATH ?? template.storage.databasePath;
  template.api.host = values.HOST ?? template.api.host;
  template.api.port = numericValue(values, 'PORT') ?? template.api.port;
  template.api.logLevel = values.LOG_LEVEL ?? template.api.logLevel;
  template.taskQueue.maxRetries = numericValue(values, 'TASK_MAX_RETRIES') ?? template.taskQueue.maxRetries;
  template.taskQueue.retryDelayMs = numericValue(values, 'TASK_RETRY_DELAY_MS') ?? template.taskQueue.retryDelayMs;
  template.cli.color = !values.NO_COLOR;
}

function createConfigFile(): void {
  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`A configuration file already exists at ${CONFIG_PATH}.`);
    console.log('Please edit it directly if you need to update the system configuration.');
    return;
  }
  const template = createDefaultSystemConfig();
  const legacyEnvPath = path.join(WORKSPACE_ROOT, '.env');
  if (fs.existsSync(legacyEnvPath)) {
    applyLegacyConfig(template, parseLegacyEnv(legacyEnvPath));
  } else {
    template.model.apiKey = 'your-api-key';
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  console.log(`Created ${CONFIG_PATH}`);
  if (fs.existsSync(legacyEnvPath)) {
    console.log('Imported existing .env values. The legacy .env file is no longer read by One Agent.');
  }
  if (!isUsableApiKey(template.model.apiKey)) {
    console.log('Please open it and set model.apiKey, then run one-agent again.');
  }
}

function validateApiKey(): boolean {
  if (isUsableApiKey(config.model.apiKey)) {
    return true;
  }
  console.error('Error: model.apiKey is missing or still uses the template placeholder.');
  console.error(`Workspace: ${WORKSPACE_ROOT}`);
  console.error('');
  console.error('To fix this, either:');
  console.error(`  1. Run "one-agent --init" to create ${CONFIG_PATH}, then edit it.`);
  console.error(`  2. Copy one-agent.config.example.json to ${CONFIG_PATH}.`);
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

function readRecoveryPoint(
  traceEventStore: TraceEventStore,
  run: AgentRun,
): RunCheckpoint | undefined {
  return traceEventStore.getLatestRecoveryPoint(run.id) ?? run.checkpoint;
}

function getRecoverableRuns(
  runStore: RunStore,
  traceEventStore: TraceEventStore,
  threadId: string,
): AgentRun[] {
  return runStore
    .getRunningByThread(threadId)
    .filter((run) => readRecoveryPoint(traceEventStore, run)?.loopMode === 'planning');
}

function printRecoveryHint(
  runStore: RunStore,
  traceEventStore: TraceEventStore,
  threadId: string,
): void {
  const recoverable = getRecoverableRuns(runStore, traceEventStore, threadId);
  if (recoverable.length === 0) return;
  console.log(cyan(`Detected ${recoverable.length} interrupted planning run(s).`));
  for (const run of recoverable) {
    const recoveryPoint = readRecoveryPoint(traceEventStore, run);
    const stepCount = recoveryPoint?.loopMode === 'planning' ? recoveryPoint.plan.steps.length : 0;
    console.log(dim(`  /resume ${shortId(run.id)}  (${stepCount} plan steps)`));
  }
}

function printWaitingHint(
  runStore: RunStore,
  traceEventStore: TraceEventStore,
  threadId: string,
  includeQuestion = true,
): void {
  const waiting = runStore.getWaitingByThread(threadId);
  const request = waiting
    ? readRecoveryPoint(traceEventStore, waiting)?.pendingInput
    : undefined;
  if (!waiting || !request) return;
  console.log(cyan(`This thread is waiting for your answer (${shortId(waiting.id)}):`));
  if (includeQuestion) console.log(request.question);
  if (request.options?.length) {
    request.options.forEach((option, index) => console.log(`  ${index + 1}. ${option}`));
  }
  console.log(dim('Type your answer to continue, or /cancel to cancel this task.'));
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

async function startTraceViewer(background: boolean): Promise<ChildProcess | null> {
  const { spawn } = await import('node:child_process');
  const traceWebPath = fileURLToPath(new URL('../../trace-web/dist/index.js', import.meta.url));
  if (!fs.existsSync(traceWebPath)) {
    console.error('Trace viewer not found. Run "pnpm build" first.');
    return null;
  }
  const tracePort = await findAvailablePort();
  const child = spawn('node', [
    traceWebPath,
    '--port', String(tracePort),
    '--host', '127.0.0.1',
    '--workspace', WORKSPACE_ROOT,
  ], {
    stdio: background ? 'ignore' : 'inherit',
    detached: false,
    env: {
      ...process.env,
    },
  });
  console.log(cyan(`Trace viewer: http://127.0.0.1:${tracePort}`));
  console.log(dim(`Trace database: ${config.databasePath}`));
  return child;
}

async function waitForProcess(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code && code !== 0) {
        reject(new Error(`Trace viewer exited with code ${code}.`));
      } else if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
        reject(new Error(`Trace viewer exited after signal ${signal}.`));
      } else {
        resolve();
      }
    });
  });
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
  let args;
  try {
    args = parseArgs(undefined, config.runtime.loop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run "one-agent --help" for usage.');
    process.exitCode = 1;
    return;
  }
  const {
    command,
    threadId: argThreadId,
    newThread,
    verbose,
    help,
    version,
    init,
    loop,
    withTrace,
    deprecatedFlags,
  } = args;

  if (help) {
    printHelp();
    return;
  }

  if (version) {
    printVersion();
    return;
  }

  if (init) {
    createConfigFile();
    return;
  }

  for (const flag of deprecatedFlags) {
    const replacement = flag === '--plan'
      ? '--loop planning'
      : flag === '--plan-auto'
        ? '--loop auto'
        : 'one-agent trace';
    console.warn(dim(`${flag} is deprecated; use ${replacement}.`));
  }

  if (command === 'trace') {
    try {
      const traceProcess = await startTraceViewer(false);
      if (!traceProcess) {
        process.exitCode = 1;
        return;
      }
      await waitForProcess(traceProcess);
    } catch (error) {
      console.error(`Trace viewer failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (!validateApiKey()) {
    process.exit(1);
  }

  if (!config.model.baseUrl) {
    console.warn(
      'Warning: model.baseUrl is not set. The client will use the Provider default endpoint.'
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
  const planning = toPlanningOption(loop);

  try {
    const resolution = resolveThread(
      args,
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

  let agent = runtime.createAgent({ threadId, planning });
  printRecoveryHint(runStore, traceEventStore, threadId);
  printWaitingHint(runStore, traceEventStore, threadId);
  void memoryConsolidator.recoverUnextracted();

  // Optionally start the trace web viewer in the background.
  let traceProcess: ChildProcess | null = null;
  if (withTrace) {
    try {
      traceProcess = await startTraceViewer(true);
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
  let closeNoticePrinted = false;
  process.on('SIGINT', () => {
    sigintCount++;
    if (abortController && sigintCount === 1) {
      console.log('\nInterrupting current turn... press Ctrl-C again to force quit.');
      abortController.abort();
      abortController = null;
    } else if (!abortController && sigintCount === 1) {
      console.log('\nClosing session and consolidating memory...');
      closeNoticePrinted = true;
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
      console.log('正在整理会话记忆，请稍候...');
      closeNoticePrinted = true;
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
          console.log(`${prefix}: ${formatHistoryContent(message.content)}`);
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
      agent = runtime.createAgent({ threadId, planning });
      void memoryConsolidator.consolidateThread(leavingThreadId);
      console.log(`Switched to thread ${threadId}${title ? ` (${title})` : ''}`);
      printRecoveryHint(runStore, traceEventStore, threadId);
      printWaitingHint(runStore, traceEventStore, threadId);
      continue;
    }

    if (trimmed === '/resume') {
      console.log('Usage: /resume <run-id>');
      printRecoveryHint(runStore, traceEventStore, threadId);
      continue;
    }

    if (trimmed.startsWith('/resume ')) {
      const id = trimmed.slice('/resume '.length).trim();
      const run = runStore.getById(id) ?? getRecoverableRuns(runStore, traceEventStore, threadId)
        .find((candidate) => candidate.id.startsWith(id));
      if (
        !run ||
        run.threadId !== threadId ||
        readRecoveryPoint(traceEventStore, run)?.loopMode !== 'planning'
      ) {
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

    if (trimmed === '/cancel') {
      const waiting = runStore.getWaitingByThread(threadId);
      if (!waiting) {
        console.log('No task is waiting for input in this thread.');
      } else if (agent.cancelWaitingRun(waiting.id)) {
        console.log(`Cancelled waiting run ${shortId(waiting.id)}.`);
      } else {
        console.log('The waiting task was already continued or cancelled.');
      }
      continue;
    }

    const waiting = runStore.getWaitingByThread(threadId);
    if (waiting) {
      printSeparator();
      sigintCount = 0;
      abortController = new AbortController();
      const progress = createProgressIndicator(`正在继续 ${shortId(waiting.id)}…`);
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
        const result = await agent.continueRun(waiting.id, trimmed, abortController.signal);
        const renderable = sanitizeTerminalText(result.reply).trim();
        process.stdout.write('\n');
        if (!timeline.hasStreamedLive && renderable) {
          console.log(`\n${renderMarkdown(renderable)}`);
        }
        if (result.status === 'waiting_for_input') {
          printWaitingHint(runStore, traceEventStore, threadId);
        } else {
          console.log(dim(`Continued as run ${shortId(result.runId ?? '')}.`));
        }
      } catch (error) {
        printError(categorizeError(error, waiting.id, verbose), verbose);
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

      const progress = createProgressIndicator(`正在请求 ${config.model.model}…`);
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
      let runResult: AgentRunResult;
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
      if (runResult.status === 'waiting_for_input') {
        printWaitingHint(runStore, traceEventStore, threadId, false);
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

  const consolidation = await memoryConsolidator.consolidateThread(threadId);
  if (closeNoticePrinted) {
    if (consolidation.status === 'failed') {
      console.log('记忆整理暂未完成，将在下次启动时重试。');
    } else {
      console.log('记忆整理完成，已退出。');
    }
  }
  if (traceProcess) traceProcess.kill();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
