import './load-env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  EvalRunner,
  builtInEvalTasks,
  realModelBenchmarkTasks,
  loadEvalDataset,
} from '@one-agent/agent-core';

function getFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  const realMode = process.argv.includes('--real');
  const trace = process.argv.includes('--trace');
  const datasetDir = getFlagValue('--dataset');
  const traceDbPath = trace ? resolve(getFlagValue('--db') ?? './eval-traces.db') : undefined;

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'one-agent-eval-'));
  const runner = new EvalRunner();

  const tasks = datasetDir
    ? loadEvalDataset(resolve(datasetDir))
    : realMode
      ? realModelBenchmarkTasks
      : builtInEvalTasks;

  const taskSource = datasetDir ? `dataset ${resolve(datasetDir)}` : 'built-in';
  console.log(
    `Running evaluation in ${realMode ? 'real' : 'mock'} mode on ${tasks.length} task(s) (${taskSource})...\n`,
  );

  const summary = await runner.run({
    tasks,
    workspaceRoot,
    mode: realMode ? 'real' : 'mock',
    traceDbPath,
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
    if (result.maxScore !== undefined) {
      metrics.push(`score=${result.score}/${result.maxScore}`);
    }
    totalDuration += result.durationMs;
    console.log(`[${status}] ${result.taskId} - ${metrics.join(' | ')}`);
    if (!result.passed) {
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
      for (const checkpoint of result.checkpointResults ?? []) {
        if (checkpoint.earned < checkpoint.points) {
          console.log(
            `  - checkpoint ${checkpoint.id} (${checkpoint.earned}/${checkpoint.points}): ${checkpoint.errors.join('; ')}`,
          );
        }
      }
      if (result.threadId) {
        console.log(`  - trace: thread ${result.threadId}`);
      }
    }
  }

  const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(0) : '0';
  console.log('');
  console.log(`Summary: ${summary.passed}/${summary.total} passed (${passRate}%) | ${totalDuration}ms total | ${totalTokens} tokens`);
  if (summary.totalMaxScore !== undefined) {
    console.log(`Score: ${summary.totalScore}/${summary.totalMaxScore} checkpoint points`);
  }

  if (traceDbPath) {
    console.log('');
    console.log(`Traces saved to ${traceDbPath}`);
    console.log(`View failures: DATABASE_PATH=${traceDbPath} pnpm dev:trace-web`);
  }

  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
