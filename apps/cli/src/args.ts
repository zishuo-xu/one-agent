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
    newThread: argv.includes('--new-thread'),
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
