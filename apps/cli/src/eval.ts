import './load-config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  EvalRunner,
  builtInEvalTasks,
  realModelBenchmarkTasks,
  loadEvalDataset,
} from '@one-agent/agent-eval';
import { parseEvalConcurrency } from './eval-options.js';

function getFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  const realMode = process.argv.includes('--real');
  const planning = process.argv.includes('--planning');
  const trace = process.argv.includes('--trace');
  const concurrency = parseEvalConcurrency(process.argv.slice(2));
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
    `Running evaluation in ${realMode ? 'real' : 'mock'} mode${planning ? ' with PlanningLoop' : ''} on ${tasks.length} task(s) (${taskSource}, concurrency=${concurrency})...\n`,
  );

  const evaluationStartedAt = Date.now();
  const summary = await runner.run({
    tasks,
    workspaceRoot,
    mode: realMode ? 'real' : 'mock',
    concurrency,
    // Tasks that set enablePlanning explicitly keep their own value; the flag
    // is the default for everything else (SimpleLoop vs PlanningLoop control).
    enablePlanning: planning,
    traceDbPath,
  });
  const wallDuration = Date.now() - evaluationStartedAt;

  let totalTokens = 0;
  let totalDuration = 0;
  const verificationCounts = new Map<string, number>();

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
    if (result.completionOutcome) {
      metrics.push(`verification=${result.completionOutcome.status}`);
      verificationCounts.set(
        result.completionOutcome.status,
        (verificationCounts.get(result.completionOutcome.status) ?? 0) + 1,
      );
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
  console.log(
    `Summary: ${summary.passed}/${summary.total} passed (${passRate}%) | ${wallDuration}ms wall | ${totalDuration}ms cumulative task time | ${totalTokens} tokens`,
  );
  if (verificationCounts.size > 0) {
    console.log(
      `Verification: ${[...verificationCounts.entries()].map(([status, count]) => `${status}=${count}`).join(' | ')}`,
    );
  }
  if (summary.totalMaxScore !== undefined) {
    console.log(`Score: ${summary.totalScore}/${summary.totalMaxScore} checkpoint points`);
  }

  if (traceDbPath) {
    console.log('');
    console.log(`Traces saved to ${traceDbPath}`);
    console.log(`View failures: set storage.databasePath to ${traceDbPath}, then run one-agent trace`);
  }

  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
