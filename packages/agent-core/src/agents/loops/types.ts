import type { ContextManager } from '../../context/ContextManager.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolCall, ToolResult } from '../../tools/types.js';
import type { Planner } from '../../planning/Planner.js';
import type { ReasoningChain } from '../../planning/ReasoningChain.js';
import type { TaskJudge } from '../../planning/TaskJudge.js';
import type { ModelCaller } from '../ModelCaller.js';
import type { RunRecorder } from '../RunRecorder.js';
import type { SubAgentRunner } from '../SubAgentRunner.js';
import type { RunCheckpoint } from '../checkpoint.js';

/** Collaborators every loop strategy shares (assembled once by AgentLoop). */
export interface LoopInfrastructure {
  contextManager: ContextManager;
  modelCaller: ModelCaller;
  recorder: RunRecorder;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  planner: Planner;
  taskJudge: TaskJudge;
  subAgentRunner?: SubAgentRunner;
  maxToolIterations: number;
  maxReplanAttempts: number;
  maxRetryAttempts: number;
  checkSignal: () => void;
  persistToolCall: (runId: string | undefined, toolCall: ToolCall, result: ToolResult) => void;
  saveCheckpoint: (runId: string | undefined, checkpoint: RunCheckpoint) => void;
}

/** Per-chat input for a loop run. */
export interface LoopRunInput {
  message: string;
  runId?: string;
  memories?: string;
  reasoningChain: ReasoningChain;
  resumeCheckpoint?: RunCheckpoint;
  resumedFromRunId?: string;
}

/** One execution strategy. Add a new loop mode by implementing this interface. */
export interface LoopStrategy {
  run(input: LoopRunInput): Promise<{ reply: string }>;
}
