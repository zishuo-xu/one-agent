import './load-env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunner, builtInEvalTasks, realModelBenchmarkTasks } from '@one-agent/agent-core';

async function main() {
  const realMode = process.argv.includes('--real');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'one-agent-eval-'));
  const runner = new EvalRunner();

  const tasks = realMode ? realModelBenchmarkTasks : builtInEvalTasks;
  console.log(`Running evaluation in ${realMode ? 'real' : 'mock'} mode on ${tasks.length} task(s)...\n`);

  const summary = await runner.run({
    tasks,
    workspaceRoot,
    mode: realMode ? 'real' : 'mock',
  });

  let totalTokens = 0;
  let totalDuration = 0;

  for (const result of summary.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const metrics: string[] = [`${result.durationMs}ms`];
    if (result.tokenUsage) {
      metrics.push(`tokens=${result.tokenUsage.totalTokens}`);
      totalTokens += result.tokenUsage.totalTokens;
    }
    if (result.planningMetrics) {
      metrics.push(`plans=${result.planningMetrics.planCount}`);
      metrics.push(`steps=${result.planningMetrics.planStepCount}`);
      metrics.push(`reflections=${result.reflectionCount ?? 0}`);
    }
    totalDuration += result.durationMs;
    console.log(`[${status}] ${result.taskId} - ${metrics.join(' | ')}`);
    if (!result.passed) {
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
    }
  }

  const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(0) : '0';
  console.log('');
  console.log(`Summary: ${summary.passed}/${summary.total} passed (${passRate}%) | ${totalDuration}ms total | ${totalTokens} tokens`);

  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
