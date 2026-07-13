export interface CliArgs {
  threadId?: string;
  newThread: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  init: boolean;
  plan: boolean;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const threadIndex = argv.indexOf('--thread');
  const threadId =
    threadIndex >= 0 && argv[threadIndex + 1] && !argv[threadIndex + 1].startsWith('-')
      ? argv[threadIndex + 1]
      : undefined;

  return {
    threadId,
    newThread: argv.includes('--new-thread') || argv.includes('--new'),
    verbose: argv.includes('--verbose'),
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
    init: argv.includes('--init'),
    plan: argv.includes('--plan'),
  };
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
 * - `--thread <id>` + `--new`: create a thread with that exact id.
 * - `--thread <id>` (no --new): resume it if it exists, else create.
 * - `--new` only: always create a fresh thread.
 * - Neither: resume the most recent existing thread, else create a new one.
 */
export function resolveThread(
  args: CliArgs,
  recentThreads: { id: string; title: string | null }[],
  existsById: (id: string) => boolean,
  createThread: (id?: string) => string,
): ThreadResolution {
  if (args.threadId && args.newThread) {
    if (existsById(args.threadId)) {
      throw new Error(`Cannot create thread ${args.threadId}: it already exists.`);
    }
    return { threadId: createThread(args.threadId), mode: 'created' };
  }
  if (args.threadId) {
    if (existsById(args.threadId)) {
      return { threadId: args.threadId, mode: 'resumed' };
    }
    return { threadId: createThread(args.threadId), mode: 'created' };
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
