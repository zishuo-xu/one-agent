import './load-env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunner, builtInEvalTasks } from '@one-agent/agent-core';

async function main() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'one-agent-eval-'));
  const runner = new EvalRunner();

  console.log(`Running evaluation on ${builtInEvalTasks.length} tasks...\n`);

  const summary = await runner.run({
    tasks: builtInEvalTasks,
    workspaceRoot,
  });

  console.log(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}\n`);

  for (const result of summary.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${result.taskId} - ${result.durationMs}ms`);
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
