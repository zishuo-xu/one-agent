import './load-env.js';
import { parseArgs } from './args.js';

async function dispatch(): Promise<void> {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run "one-agent --help" for usage.');
    process.exitCode = 1;
    return;
  }

  // Keep diagnostics independent from database and AgentRuntime startup. A
  // broken model configuration can therefore be reported by doctor itself.
  if (args.command === 'doctor' && !args.help && !args.version && !args.init) {
    try {
      const { runDoctorCommand } = await import('./commands/doctor.js');
      await runDoctorCommand();
    } catch (error) {
      console.error(`Doctor failed to load configuration: ${
        error instanceof Error ? error.message : String(error)
      }`);
      process.exitCode = 1;
    }
    return;
  }

  await import('./chat.js');
}

dispatch().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
