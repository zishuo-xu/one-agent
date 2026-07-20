import { z } from 'zod';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { modelName } from '../configAccess.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelCallTraceEvent, ModelProvider, TokenUsage } from '../model/types.js';
import { ToolDefinition } from '../tools/types.js';
import { Plan, PlanStep, PlannerOptions, FailureAnalysis } from './types.js';
import { extractJsonObject } from './extractJson.js';

interface RawPlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  delegate?: boolean;
  parallel?: boolean;
  children?: RawPlanStep[];
}

const planStepSchema: z.ZodType<RawPlanStep, z.ZodTypeDef, RawPlanStep> = z.lazy(() =>
  z.object({
    id: z.string(),
    description: z.string(),
    toolName: z.string().optional(),
    expectedOutcome: z.string().optional(),
    delegate: z.boolean().optional(),
    parallel: z.boolean().optional(),
    children: z.array(planStepSchema).optional(),
  })
);

const planSchema = z.object({
  reasoning: z.string(),
  steps: z.array(planStepSchema),
});

export class Planner {
  private readonly systemPrompt: string;
  private readonly modelProvider: ModelProvider;
  private readonly timeoutMs: number;
  /**
   * Optional usage sink so the caller can roll planning-model spend into the
   * run's token accounting (wired by AgentLoop; not part of the conversation
   * context, so it never anchors the context-size estimate).
   */
  onUsage?: (usage: TokenUsage) => void;
  onTrace?: (event: ModelCallTraceEvent) => void;

  constructor(options: PlannerOptions = {}) {
    this.systemPrompt =
      options.systemPrompt ??
      'You are a planning assistant. Break down the user request into clear, executable steps. ' +
      'Each step may optionally use a tool. Respond ONLY with a JSON object matching the requested format.';
    this.modelProvider =
      options.modelProvider ??
      (options.model
        ? new OpenAICompatibleProvider(config.openai, options.model)
        : config.planningModelProvider ??
          config.modelProvider ??
          new OpenAICompatibleProvider(config.openai, modelName()));
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async createPlan(
    userRequest: string,
    tools: ToolDefinition[],
    memories?: string,
    previousPlan?: Plan,
    failureAnalysis?: FailureAnalysis,
    revisionFeedback?: string,
  ): Promise<Plan> {
    const toolDescriptions = tools
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');

    const memorySection = memories
      ? `\n${memories}\n`
      : '';

    const previousPlanSection = previousPlan
      ? `\nPrevious plan:\n${previousPlan.steps.map((s) => `- ${s.id}. ${s.description} (${s.status})`).join('\n')}\n`
      : '';

    const failureSection = failureAnalysis
      ? `\nPrevious attempt failed. Failure analysis:\n` +
        `- Category: ${failureAnalysis.category}\n` +
        `- Affected steps: ${failureAnalysis.affectedStepIds?.join(', ') ?? 'unknown'}\n` +
        `- Root cause: ${failureAnalysis.rootCause ?? 'unknown'}\n` +
        `- Recommendation: ${failureAnalysis.recommendation ?? 'none'}\n` +
        `Please create a revised plan that addresses the root cause.\n`
      : '';

    const revisionSection = revisionFeedback
      ? `\nThe user reviewed the previous plan and requested this change:\n${revisionFeedback}\n` +
        'Create one revised plan that follows this feedback while preserving the original request.\n'
      : '';

    const prompt =
      'Create a step-by-step plan to accomplish the following request.\n\n' +
      'Request:\n' +
      `${userRequest}\n` +
      memorySection +
      previousPlanSection +
      failureSection +
      revisionSection +
      '\nAvailable tools:\n' +
      `${toolDescriptions || '(none)'}\n\n` +
      'Delegation:\n' +
      '- Set "delegate": true on steps that are self-contained subtasks better executed by an isolated sub-agent with its own tool loop.\n' +
      '- Set "parallel": true on delegated steps that are independent of each other, so they run in parallel.\n' +
      '- A step with "children" is only a grouping container: never set "delegate" or "parallel" on the container; put those flags on each independent leaf child.\n' +
      '- Parallel steps MUST be read-only (no file writes or side effects) and MUST NOT depend on each other\'s output.\n' +
      '- Use delegation sparingly; simple sequential steps need neither flag.\n\n' +
      'Requirements fidelity:\n' +
      '- If the request explicitly specifies an output file name or location (e.g. "write REPORT.md to the workspace root"), steps MUST use that exact name and location — never invent substitutes.\n' +
      '- Intermediate results produced by earlier steps are available in the conversation context; do NOT assume they exist as files and do NOT plan steps to "find" them.\n\n' +
      'Autonomy:\n' +
      '- Never plan steps that wait for or request user input mid-plan; the plan must run to completion unattended.\n' +
      '- If required information is missing and cannot be obtained with tools, make a reasonable assumption and note it in the final answer instead of stalling.\n\n' +
      'You must respond ONLY with a JSON object matching this exact format, no markdown, no explanation:\n' +
      '{\n' +
      '  "reasoning": "brief explanation of the plan",\n' +
      '  "steps": [\n' +
      '    {\n' +
      '      "id": "1",\n' +
      '      "description": "what to do in this step",\n' +
      '      "toolName": "optional_tool_name",\n' +
      '      "expectedOutcome": "what should happen after this step",\n' +
      '      "delegate": false,\n' +
      '      "parallel": false,\n' +
      '      "children": [\n' +
      '        {\n' +
      '          "id": "1.1",\n' +
      '          "description": "sub-step description",\n' +
      '          "toolName": "optional_tool_name",\n' +
      '          "expectedOutcome": "sub-step outcome"\n' +
      '        }\n' +
      '      ]\n' +
      '    }\n' +
      '  ]\n' +
      '}\n\n' +
      'Example:\n' +
      '{\n' +
      '  "reasoning": "Read the requested file and summarize its content.",\n' +
      '  "steps": [\n' +
      '    {\n' +
      '      "id": "1",\n' +
      '      "description": "Read data.txt",\n' +
      '      "toolName": "read_file",\n' +
      '      "expectedOutcome": "File content retrieved"\n' +
      '    },\n' +
      '    {\n' +
      '      "id": "2",\n' +
      '      "description": "Summarize the content for the user",\n' +
      '      "expectedOutcome": "A concise summary is produced"\n' +
      '    }\n' +
      '  ]\n' +
      '}';

    try {
      const raw = await this.callModelWithJsonFormat(prompt);
      return this.parsePlan(raw, userRequest);
    } catch (error) {
      return this.fallbackPlan(userRequest, String(error));
    }
  }

  async revisePlan(
    userRequest: string,
    tools: ToolDefinition[],
    feedback: string,
    previousPlan: Plan,
    memories?: string,
  ): Promise<Plan> {
    return this.createPlan(userRequest, tools, memories, previousPlan, undefined, feedback);
  }

  private async callModelWithJsonFormat(prompt: string): Promise<string> {
    // jsonMode fallback (retrying without response_format when the endpoint
    // does not support it) is handled inside the provider.
    const modelCallId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const messages = [
      { role: 'system' as const, content: this.systemPrompt },
      { role: 'user' as const, content: prompt },
    ];
    this.onTrace?.({
      type: 'model_call', phase: 'started', modelCallId, purpose: 'planner',
      provider: this.modelProvider.name, model: this.modelProvider.model,
      attempt: 0, streaming: false, startedAt, messageCount: messages.length, toolCount: 0,
    });
    try {
      const response = await this.modelProvider.complete({
        messages,
        jsonMode: true,
        timeoutMs: this.timeoutMs,
      });
      if (response.usage) {
        this.onUsage?.(response.usage);
      }
      this.onTrace?.({
        type: 'model_call', phase: 'completed', modelCallId, purpose: 'planner',
        provider: this.modelProvider.name, model: this.modelProvider.model,
        attempt: 0, streaming: false, startedAt, durationMs: Date.now() - startedMs,
        usage: response.usage,
      });
      return response.content || '{}';
    } catch (error) {
      this.onTrace?.({
        type: 'model_call', phase: 'failed', modelCallId, purpose: 'planner',
        provider: this.modelProvider.name, model: this.modelProvider.model,
        attempt: 0, streaming: false, startedAt, durationMs: Date.now() - startedMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private parsePlan(raw: string, userRequest: string): Plan {
    const extracted = extractJsonObject(raw);
    if (!extracted) {
      return this.fallbackPlan(userRequest, 'No JSON object found');
    }

    try {
      const parsed = JSON.parse(extracted);
      const validated = planSchema.parse(parsed);
      return {
        reasoning: validated.reasoning,
        steps: validated.steps.map((step) => this.prepareStep(step)),
      };
    } catch {
      return this.fallbackPlan(userRequest, 'Plan parsing failed');
    }
  }

  private prepareStep(step: RawPlanStep, parentId?: string, inheritedParallel = false): PlanStep {
    const hasChildren = Boolean(step.children?.length);
    const parallel = !hasChildren && (inheritedParallel || Boolean(step.parallel));
    const prepared: PlanStep = {
      id: step.id,
      description: step.description,
      status: 'pending',
      toolName: step.toolName,
      expectedOutcome: step.expectedOutcome,
      // Containers organize leaves; executing them would duplicate their
      // completed child work. A model that marks a container parallel means
      // its independent leaves form the wave instead.
      delegate: hasChildren ? false : parallel ? true : step.delegate,
      parallel: hasChildren ? false : parallel || undefined,
      parentId,
    };
    if (hasChildren) {
      prepared.children = step.children!.map((child) =>
        this.prepareStep(child, step.id, inheritedParallel || Boolean(step.parallel))
      );
    }
    return prepared;
  }

  private fallbackPlan(userRequest: string, error: string): Plan {
    return {
      reasoning: `Directly respond to the user request. (${error})`,
      steps: [
        {
          id: '1',
          description: `Respond to: ${userRequest}`,
          status: 'pending',
        },
      ],
    };
  }
}
