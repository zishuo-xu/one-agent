import type { ContextManager } from '../../context/ContextManager.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { Planner } from '../../planning/Planner.js';
import type { TaskJudge } from '../../planning/TaskJudge.js';
import type { ModelCaller } from '../ModelCaller.js';
import type { RunRecorder } from '../RunRecorder.js';
import type { SubAgentRunner } from '../SubAgentRunner.js';
import type { ToolRunner } from '../ToolRunner.js';
import type { RunCheckpoint } from '../checkpoint.js';
import type { RunContext } from '../RunContext.js';

/** Collaborators every loop strategy shares (assembled once by AgentLoop). */
export interface LoopInfrastructure {
  contextManager: ContextManager;
  modelCaller: ModelCaller;
  recorder: RunRecorder;
  toolRegistry?: ToolRegistry;
  toolRunner: ToolRunner;
  planner: Planner;
  taskJudge: TaskJudge;
  subAgentRunner?: SubAgentRunner;
  maxToolIterations: number;
  maxReplanAttempts: number;
  maxRetryAttempts: number;
  checkSignal: () => void;
  saveCheckpoint: (runId: string | undefined, checkpoint: RunCheckpoint) => void;
}

/** One execution strategy. Add a new loop mode by implementing this interface. */
export interface LoopStrategy {
  run(context: RunContext): Promise<{ reply: string }>;
}
