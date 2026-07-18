export interface StrategySignal {
  phase: 'before_tool_execution';
  loop: 'simple';
  toolIteration: number;
  toolCallNames: string[];
  switchCount: number;
}

export type StrategyDecision =
  | { action: 'continue' }
  | { action: 'switch_to_planning'; reason: string };

export interface StrategyControllerOptions {
  /** Maximum tool calls SimpleLoop may execute in its first batch. Default 2. */
  maxInitialToolBatch?: number;
  /** Hard cap for direct-to-planning transitions in one Run. Default 1. */
  maxSwitches?: number;
}

/**
 * The single owner of in-run strategy transitions.
 *
 * V1 deliberately switches only before the first tool batch executes. This
 * gives the controller a real runtime signal while guaranteeing that moving
 * to PlanningLoop cannot replay an already-completed side effect.
 */
export class StrategyController {
  readonly maxInitialToolBatch: number;
  readonly maxSwitches: number;

  constructor(options: StrategyControllerOptions = {}) {
    this.maxInitialToolBatch = options.maxInitialToolBatch ?? 2;
    this.maxSwitches = options.maxSwitches ?? 1;
  }

  evaluate(signal: StrategySignal): StrategyDecision {
    if (signal.switchCount >= this.maxSwitches) return { action: 'continue' };
    if (signal.toolIteration !== 0) return { action: 'continue' };
    if (signal.toolCallNames.length <= this.maxInitialToolBatch) return { action: 'continue' };
    return {
      action: 'switch_to_planning',
      reason:
        `SimpleLoop proposed ${signal.toolCallNames.length} tools in its first batch; ` +
        `the direct-execution limit is ${this.maxInitialToolBatch}.`,
    };
  }
}
