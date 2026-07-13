import { z } from 'zod';
import { config } from '../config.js';
import { ToolDefinition } from '../tools/types.js';
import { Plan, PlanStep, PlannerOptions, FailureAnalysis } from './types.js';
import { extractJsonObject } from './extractJson.js';

interface RawPlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  children?: RawPlanStep[];
}

const planStepSchema: z.ZodType<RawPlanStep, z.ZodTypeDef, RawPlanStep> = z.lazy(() =>
  z.object({
    id: z.string(),
    description: z.string(),
    toolName: z.string().optional(),
    expectedOutcome: z.string().optional(),
    children: z.array(planStepSchema).optional(),
  })
);

const planSchema = z.object({
  reasoning: z.string(),
  steps: z.array(planStepSchema),
});

export class Planner {
  private readonly systemPrompt: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: PlannerOptions = {}) {
    this.systemPrompt =
      options.systemPrompt ??
      'You are a planning assistant. Break down the user request into clear, executable steps. ' +
      'Each step may optionally use a tool. Respond ONLY with a JSON object matching the requested format.';
    this.model = options.model ?? config.model;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async createPlan(
    userRequest: string,
    tools: ToolDefinition[],
    memories?: string,
    previousPlan?: Plan,
    failureAnalysis?: FailureAnalysis
  ): Promise<Plan> {
    const toolDescriptions = tools
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');

    const memorySection = memories
      ? `\nRelevant context from past conversations:\n${memories}\n`
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

    const prompt =
      'Create a step-by-step plan to accomplish the following request.\n\n' +
      'Request:\n' +
      `${userRequest}\n` +
      memorySection +
      previousPlanSection +
      failureSection +
      '\nAvailable tools:\n' +
      `${toolDescriptions || '(none)'}\n\n` +
      'You must respond ONLY with a JSON object matching this exact format, no markdown, no explanation:\n' +
      '{\n' +
      '  "reasoning": "brief explanation of the plan",\n' +
      '  "steps": [\n' +
      '    {\n' +
      '      "id": "1",\n' +
      '      "description": "what to do in this step",\n' +
      '      "toolName": "optional_tool_name",\n' +
      '      "expectedOutcome": "what should happen after this step",\n' +
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
      const response = await this.callModelWithJsonFormat(prompt);
      const raw = response.choices[0]?.message?.content ?? '{}';
      return this.parsePlan(raw, userRequest);
    } catch (error) {
      return this.fallbackPlan(userRequest, String(error));
    }
  }

  private async callModelWithJsonFormat(prompt: string) {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: prompt },
    ] as never;

    try {
      return await config.openai.chat.completions.create(
        {
          model: this.model,
          messages,
          response_format: { type: 'json_object' },
        },
        { timeout: this.timeoutMs }
      );
    } catch {
      // Some endpoints do not support response_format; fall back to a plain call.
      return await config.openai.chat.completions.create(
        {
          model: this.model,
          messages,
        },
        { timeout: this.timeoutMs }
      );
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

  private prepareStep(step: RawPlanStep, parentId?: string): PlanStep {
    const prepared: PlanStep = {
      id: step.id,
      description: step.description,
      status: 'pending',
      toolName: step.toolName,
      expectedOutcome: step.expectedOutcome,
      parentId,
    };
    if (step.children && step.children.length > 0) {
      prepared.children = step.children.map((child) => this.prepareStep(child, step.id));
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
