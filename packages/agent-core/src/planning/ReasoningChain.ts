import { Message } from '../agents/types.js';
import { ToolCall, ToolResult } from '../tools/types.js';
import { ReasoningStep } from './types.js';

export class ReasoningChain {
  private steps: ReasoningStep[] = [];
  private currentStep: ReasoningStep = {};

  addThought(thought: string): void {
    this.currentStep.thought = thought;
  }

  addAction(action: ToolCall): void {
    this.currentStep.action = action;
  }

  addObservation(observation: ToolResult): void {
    this.currentStep.observation = observation;
    this.steps.push({ ...this.currentStep });
    this.currentStep = {};
  }

  addReflection(reflection: string): void {
    this.currentStep.reflection = reflection;
  }

  commitStep(): void {
    if (this.hasCurrentStep()) {
      this.steps.push({ ...this.currentStep });
      this.currentStep = {};
    }
  }

  getSteps(): ReasoningStep[] {
    return [...this.steps];
  }

  toMessages(): Message[] {
    const messages: Message[] = [];

    for (const step of this.steps) {
      if (step.thought) {
        messages.push({
          role: 'assistant',
          content: `Thought: ${step.thought}`,
        });
      }
      if (step.action) {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: step.action.id,
              type: 'function',
              function: {
                name: step.action.name,
                arguments: JSON.stringify(step.action.arguments),
              },
            },
          ],
        });
      }
      if (step.observation) {
        messages.push({
          role: 'tool',
          content: JSON.stringify(step.observation),
          tool_call_id: step.action?.id ?? 'unknown',
        });
      }
      if (step.reflection) {
        messages.push({
          role: 'assistant',
          content: `Reflection: ${step.reflection}`,
        });
      }
    }

    return messages;
  }

  private hasCurrentStep(): boolean {
    return (
      !!this.currentStep.thought ||
      !!this.currentStep.action ||
      !!this.currentStep.observation ||
      !!this.currentStep.reflection
    );
  }
}
