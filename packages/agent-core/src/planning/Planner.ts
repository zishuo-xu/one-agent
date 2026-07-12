import { z } from 'zod';
import { config } from '../config.js';
import { ToolDefinition } from '../tools/types.js';
import { Plan, PlanStep, PlannerOptions } from './types.js';

const planSchema = z.object({
  reasoning: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      toolName: z.string().optional(),
      expectedOutcome: z.string().optional(),
    })
  ),
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

  async createPlan(userRequest: string, tools: ToolDefinition[]): Promise<Plan> {
    const toolDescriptions = tools
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');

    const prompt =
      'Create a step-by-step plan to accomplish the following request.\n\n' +
      'Request:\n' +
      `${userRequest}\n\n` +
      'Available tools:\n' +
      `${toolDescriptions || '(none)'}\n\n` +
      'You must respond ONLY with a JSON object matching this exact format, no markdown, no explanation:\n' +
      '{\n' +
      '  "reasoning": "brief explanation of the plan",\n' +
      '  "steps": [\n' +
      '    {\n' +
      '      "id": "1",\n' +
      '      "description": "what to do in this step",\n' +
      '      "toolName": "optional_tool_name",\n' +
      '      "expectedOutcome": "what should happen after this step"\n' +
      '    }\n' +
      '  ]\n' +
      '}';

    try {
      const response = await config.openai.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt },
          ],
        },
        { timeout: this.timeoutMs }
      );

      const raw = response.choices[0]?.message?.content ?? '{}';
      return this.parsePlan(raw, userRequest);
    } catch (error) {
      return this.fallbackPlan(userRequest, String(error));
    }
  }

  private parsePlan(raw: string, userRequest: string): Plan {
    try {
      const parsed = JSON.parse(raw);
      const validated = planSchema.parse(parsed);
      return {
        reasoning: validated.reasoning,
        steps: validated.steps.map((step) => ({
          ...step,
          status: 'pending' as const,
        })),
      };
    } catch {
      return this.fallbackPlan(userRequest, 'Plan parsing failed');
    }
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
