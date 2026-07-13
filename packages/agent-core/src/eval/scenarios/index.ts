import { simpleQaTask } from './simple-qa.js';
import { readFileTask } from './read-file.js';
import { listThenReadTask } from './list-then-read.js';
import { writeFileTask } from './write-file.js';
import { invalidArgRetryTask } from './invalid-arg-retry.js';
import { planningTask } from './planning.js';
import { projectOnboardingTask } from './project-onboarding.js';
import { createTodoTask } from './create-todo.js';
import { findAndSummarizeTask } from './find-and-summarize.js';
import { multiStepQueryTask } from './multi-step-query.js';
import { refusalTask } from './refusal.js';
import { emptyWorkspaceQueryTask } from './empty-workspace-query.js';
import { fileNotFoundRecoveryTask } from './file-not-found-recovery.js';
import { summarizeLongFileTask } from './summarize-long-file.js';
import { multiToolPlanningTask } from './multi-tool-planning.js';
import { realModelPlanningTask } from './real-model-planning.js';

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
];

export {
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
};
