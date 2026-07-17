import { ToolCall, ToolResult } from '../tools/types.js';
import { ReasoningStep, FailureAnalysis } from './types.js';

/** Bucket for entries not tied to a plan step (top-level thoughts, reflections). */
const MAIN_KEY = '__main__';

/**
 * Accumulates the reasoning trace of a run. Every entry carries an explicit
 * optional planStepId instead of relying on ambient "current step" state:
 * concurrently executing steps (parallel sub-agent waves) write to separate
 * buckets and cannot clobber each other, and attribution never depends on
 * call ordering.
 *
 * Commit semantics: addObservation and addFailureAnalysis commit their
 * bucket (a completed action/failure is terminal for that step);
 * commitStep flushes any leftover partial bucket (e.g. a trailing thought).
 */
export class ReasoningChain {
  private steps: ReasoningStep[] = [];
  private readonly open = new Map<string, ReasoningStep>();

  private bucket(planStepId?: string): ReasoningStep {
    const key = planStepId ?? MAIN_KEY;
    let step = this.open.get(key);
    if (!step) {
      step = {};
      this.open.set(key, step);
    }
    return step;
  }

  private commitBucket(planStepId?: string): void {
    const key = planStepId ?? MAIN_KEY;
    const step = this.open.get(key);
    if (step && this.hasContent(step)) {
      if (planStepId !== undefined) {
        step.planStepId = planStepId;
      }
      this.steps.push({ ...step });
    }
    this.open.delete(key);
  }

  addThought(thought: string, planStepId?: string): void {
    const step = this.bucket(planStepId);
    step.thought = thought;
    step.planStepId = planStepId;
  }

  addAction(action: ToolCall, planStepId?: string): void {
    const step = this.bucket(planStepId);
    step.action = action;
    step.planStepId = planStepId;
  }

  /** Records the observation and commits this step's bucket. */
  addObservation(observation: ToolResult, planStepId?: string): void {
    const step = this.bucket(planStepId);
    step.observation = observation;
    step.planStepId = planStepId;
    this.commitBucket(planStepId);
  }

  addReflection(reflection: string, planStepId?: string): void {
    const step = this.bucket(planStepId);
    step.reflection = reflection;
    if (planStepId !== undefined) {
      step.planStepId = planStepId;
    }
  }

  /**
   * Records the failure analysis and commits immediately: failure analysis
   * is terminal evidence for a step, so the judge (which reads getSteps())
   * actually sees what just failed, and stale state cannot leak into the
   * next step's thought/action.
   */
  addFailureAnalysis(failureAnalysis: FailureAnalysis, planStepId?: string): void {
    const step = this.bucket(planStepId);
    step.failureAnalysis = failureAnalysis;
    step.planStepId = planStepId;
    this.commitBucket(planStepId);
  }

  /** Flush any leftover partial step (e.g. a thought without observation). */
  commitStep(planStepId?: string): void {
    this.commitBucket(planStepId);
  }

  getSteps(): ReasoningStep[] {
    return [...this.steps];
  }

  getStepsByPlanStep(planStepId: string): ReasoningStep[] {
    return this.steps.filter((s) => s.planStepId === planStepId);
  }

  private hasContent(step: ReasoningStep): boolean {
    return (
      !!step.thought ||
      !!step.action ||
      !!step.observation ||
      !!step.reflection ||
      !!step.failureAnalysis
    );
  }
}
