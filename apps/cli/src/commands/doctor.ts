import { bold, dim, green, padEnd, red, yellow } from '../format.js';

type CoreModule = typeof import('@one-agent/agent-core');
type DiagnosticReport = Awaited<ReturnType<CoreModule['diagnoseModelProviders']>>;
type DiagnosticCheck = DiagnosticReport['providers'][number]['checks'][number];

function capabilityLabel(value: string): string {
  if (value === 'best_effort') return yellow(`${value} (not guaranteed)`);
  if (value === 'unsupported') return dim(value);
  return green(value);
}

function statusLabel(status: DiagnosticCheck['status']): string {
  if (status === 'pass') return green(padEnd('PASS', 8));
  if (status === 'warn') return yellow(padEnd('WARN', 8));
  if (status === 'skip') return dim(padEnd('SKIP', 8));
  return red(padEnd('FAIL', 8));
}

function printCapabilities(provider: DiagnosticReport['providers'][number]): void {
  const capabilities = provider.capabilities;
  console.log(bold('  Capability contract'));
  console.log(`    ${padEnd('streaming', 18)}${capabilityLabel(capabilities.streaming)}`);
  console.log(`    ${padEnd('tool calling', 18)}${capabilityLabel(capabilities.toolCalling)}`);
  console.log(`    ${padEnd('structured output', 18)}${capabilityLabel(capabilities.structuredOutput)}`);
  console.log(`    ${padEnd('reasoning', 18)}${capabilityLabel(capabilities.reasoning)}`);
  console.log(`    ${padEnd('context window', 18)}${capabilities.contextWindow ?? 'not declared'}`);
}

function printChecks(checks: DiagnosticCheck[]): void {
  console.log(bold('  Checks'));
  for (const check of checks) {
    const latency = check.latencyMs === undefined ? '' : ` ${check.latencyMs}ms`;
    console.log(
      `    ${padEnd(check.name, 20)}${statusLabel(check.status)}${check.message}${dim(latency)}`,
    );
  }
}

export async function runDoctorCommand(): Promise<void> {
  const core = await import('@one-agent/agent-core');
  console.log(bold('One Agent model doctor'));
  console.log(dim('Runs 3 live model calls per Provider; no Agent Run, tool execution, or Trace is created.'));
  console.log('');

  const report = await core.diagnoseModelProviders(core.config.modelProvider, {
    timeoutMs: Math.min(core.config.model.timeoutMs, 15000),
  });

  for (const provider of report.providers) {
    console.log(bold(`${provider.index + 1}. ${provider.role.toUpperCase()}`));
    console.log(`  ${padEnd('provider', 18)}${provider.provider}`);
    console.log(`  ${padEnd('model', 18)}${provider.model}`);
    console.log(`  ${padEnd('endpoint', 18)}${provider.endpoint ?? 'not exposed'}`);
    printCapabilities(provider);
    printChecks(provider.checks);
    console.log(`  ${padEnd('ready', 18)}${provider.ready ? green('YES') : red('NO')}`);
    console.log('');
  }

  console.log(`${bold('Runtime ready:')} ${report.ready ? green('YES') : red('NO')}`);
  if (!report.ready) process.exitCode = 1;
}
