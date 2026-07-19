export type CliCommand = 'chat' | 'trace' | 'doctor';
export type LoopMode = 'auto' | 'simple' | 'planning';

export interface CliArgs {
  command: CliCommand;
  threadId?: string;
  newThread: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  init: boolean;
  loop: LoopMode;
  withTrace: boolean;
  deprecatedFlags: string[];
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const threadIndex = argv.indexOf('--thread');
  const threadId =
    threadIndex >= 0 && argv[threadIndex + 1] && !argv[threadIndex + 1].startsWith('-')
      ? argv[threadIndex + 1]
      : undefined;
  const newThread = argv.includes('--new-thread') || argv.includes('--new');
  if (threadId && newThread) {
    throw new Error('Do not combine --new with --thread. Choose a new or an existing conversation.');
  }

  const valueFlags = new Set(['--thread', '--workspace', '--loop']);
  const positional = argv.find((arg, index) =>
    !arg.startsWith('-') && !valueFlags.has(argv[index - 1] ?? ''),
  );
  if (positional && positional !== 'trace' && positional !== 'doctor') {
    throw new Error(`Unknown command: ${positional}`);
  }

  const loopIndex = argv.indexOf('--loop');
  const explicitLoop = loopIndex >= 0 ? argv[loopIndex + 1] : undefined;
  if (loopIndex >= 0 && (!explicitLoop || explicitLoop.startsWith('-'))) {
    throw new Error('--loop requires one of: auto, simple, planning');
  }
  if (explicitLoop && !['auto', 'simple', 'planning'].includes(explicitLoop)) {
    throw new Error(`Invalid --loop value: ${explicitLoop}. Expected auto, simple, or planning.`);
  }

  const legacyPlan = argv.includes('--plan');
  const legacyAuto = argv.includes('--plan-auto');
  if (legacyPlan && legacyAuto) {
    throw new Error('Use only one loop mode. Prefer --loop auto|simple|planning.');
  }
  if (explicitLoop && (legacyPlan || legacyAuto)) {
    throw new Error('Do not combine --loop with legacy --plan or --plan-auto.');
  }
  const deprecatedFlags = [
    legacyPlan ? '--plan' : '',
    legacyAuto ? '--plan-auto' : '',
    argv.includes('--trace') ? '--trace' : '',
  ].filter(Boolean);
  const loop = (explicitLoop as LoopMode | undefined) ??
    (legacyPlan ? 'planning' : 'auto');

  return {
    command: positional === 'trace' || positional === 'doctor' ? positional : 'chat',
    threadId,
    newThread,
    verbose: argv.includes('--verbose'),
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
    init: argv.includes('--init'),
    loop,
    withTrace: argv.includes('--trace'),
    deprecatedFlags,
  };
}

export function toPlanningOption(loop: LoopMode): boolean | 'auto' {
  if (loop === 'simple') return false;
  if (loop === 'planning') return true;
  return 'auto';
}

export function isUsableApiKey(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && normalized !== 'your-api-key' && normalized !== 'sk-your-api-key');
}

export interface ThreadResolution {
  threadId: string;
  mode: 'created' | 'resumed';
}

/**
 * Pure decision function for which thread to use at startup.
 * - `--thread <id>`: resume an existing thread or fail clearly.
 * - `--new` only: always create a fresh thread.
 * - Neither: resume the most recent existing thread, else create a new one.
 */
export function resolveThread(
  args: CliArgs,
  recentThreads: { id: string; title: string | null }[],
  existsById: (id: string) => boolean,
  createThread: (id?: string) => string,
): ThreadResolution {
  if (args.threadId) {
    if (existsById(args.threadId)) {
      return { threadId: args.threadId, mode: 'resumed' };
    }
    throw new Error(`Thread not found: ${args.threadId}`);
  }
  if (args.newThread) {
    return { threadId: createThread(), mode: 'created' };
  }
  const recent = recentThreads[0];
  if (recent) {
    return { threadId: recent.id, mode: 'resumed' };
  }
  return { threadId: createThread(), mode: 'created' };
}
