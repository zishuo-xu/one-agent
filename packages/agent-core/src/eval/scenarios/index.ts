import type { EvalTask } from '../types.js';
import { loadEvalDataset, resolveBundledDatasetDir } from '../datasetLoader.js';

/**
 * Built-in eval scenarios are data-driven: each task is a JSON file under
 * `eval-datasets/` (mock/ for deterministic replay, real/ for real-model
 * benchmarks). This module only wires the loaded data to the historical
 * export surface so existing consumers keep working unchanged.
 */
const tasksById = new Map<string, EvalTask>();
for (const task of loadEvalDataset(resolveBundledDatasetDir())) {
  tasksById.set(task.id, task);
}

function task(id: string): EvalTask {
  const found = tasksById.get(id);
  if (!found) {
    throw new Error(`Built-in eval scenario missing from dataset: ${id}`);
  }
  return found;
}

export const simpleQaTask = task('simple-qa');
export const readFileTask = task('read-file');
export const listThenReadTask = task('list-then-read');
export const writeFileTask = task('write-file');
export const invalidArgRetryTask = task('invalid-arg-retry');
export const planningTask = task('planning');
export const projectOnboardingTask = task('project-onboarding');
export const createTodoTask = task('create-todo');
export const findAndSummarizeTask = task('find-and-summarize');
export const multiStepQueryTask = task('multi-step-query');
export const refusalTask = task('refusal');
export const emptyWorkspaceQueryTask = task('empty-workspace-query');
export const fileNotFoundRecoveryTask = task('file-not-found-recovery');
export const summarizeLongFileTask = task('summarize-long-file');
export const multiToolPlanningTask = task('multi-tool-planning');
export const realModelPlanningTask = task('real-model-planning');
export const getTimeTask = task('get-time');
export const toolChainTask = task('tool-chain');
export const replanScenarioTask = task('replan-scenario');
export const offlineAnswerTask = task('offline-answer');
export const realModelBenchmarkTask = task('real-model-benchmark');

export const builtInEvalTasks = [
  simpleQaTask,
  readFileTask,
  listThenReadTask,
  writeFileTask,
  invalidArgRetryTask,
  planningTask,
  projectOnboardingTask,
  createTodoTask,
  findAndSummarizeTask,
  multiStepQueryTask,
  refusalTask,
  emptyWorkspaceQueryTask,
  fileNotFoundRecoveryTask,
  summarizeLongFileTask,
  multiToolPlanningTask,
  realModelPlanningTask,
  getTimeTask,
  toolChainTask,
  replanScenarioTask,
  offlineAnswerTask,
];

/** Scenarios designed for real-model evaluation (no mockResponses needed). */
export const realModelBenchmarkTasks = [
  realModelPlanningTask,
  realModelBenchmarkTask,
];
