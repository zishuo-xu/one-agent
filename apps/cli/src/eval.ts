import './load-env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunner, builtInEvalTasks, realModelPlanningTask } from '@one-agent/agent-core';

async function main() {
  const realMode = process.argv.includes('--real');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'one-agent-eval-'));
  const runner = new EvalRunner();

  const tasks = realMode ? [realModelPlanningTask] : builtInEvalTasks;
  console.log(`Running evaluation in ${realMode ? 'real' : 'mock'} mode on ${tasks.length} task(s)...\n`);

  const summary = await runner.run({
    tasks,
    workspaceRoot,
    mode: realMode ? 'real' : 'mock',
  });

  console.log(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}\n`);

  for (const result of summary.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const metrics = result.planningMetrics
      ? ` | plans=${result.planningMetrics.planCount} steps=${result.planningMetrics.planStepCount} reflections=${result.reflectionCount ?? 0}`
      : '';
    console.log(`[${status}] ${result.taskId} - ${result.durationMs}ms${metrics}`);
    if (!result.passed) {
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
    }
  }

  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
