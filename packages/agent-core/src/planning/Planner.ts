import { z } from 'zod';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { modelName, runtimeSettings } from '../configAccess.js';
import { OpenAICompatibleProvider } from '../model/OpenAICompatibleProvider.js';
import type { ModelCallTraceEvent, ModelProvider, TokenUsage } from '../model/types.js';
import { AgentTokenBudgetExceededError } from '../model/TokenBudget.js';
import { localizedText, runtimePreferenceInstruction } from '../runtimePreferences.js';
import { ToolDefinition } from '../tools/types.js';
import {
  Plan,
  PlanChecklistItem,
  PlanExecutor,
  PlanStep,
  PlannerOptions,
  FailureAnalysis,
} from './types.js';
import { extractJsonObject } from './extractJson.js';

interface RawPlanStep {
  id: string;
  description: string;
  toolName?: string;
  expectedOutcome?: string;
  expectedEvidence?: string[];
  constraints?: string[];
  scope?: string[];
  nonGoals?: string[];
  delegationReason?: string;
  executor?: PlanExecutor;
  delegate?: boolean;
  parallel?: boolean;
  dependsOn?: string[];
  checklist?: PlanChecklistItem[];
  children?: RawPlanStep[];
}

const checklistItemSchema = z.object({
  id: z.string(),
  description: z.string(),
});

const planStepSchema: z.ZodType<RawPlanStep, z.ZodTypeDef, RawPlanStep> = z.lazy(() =>
  z.object({
    id: z.string(),
    description: z.string(),
    toolName: z.string().optional(),
    expectedOutcome: z.string().optional(),
    expectedEvidence: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    scope: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    delegationReason: z.string().optional(),
    executor: z.enum(['main', 'subagent']).optional(),
    delegate: z.boolean().optional(),
    parallel: z.boolean().optional(),
    dependsOn: z.array(z.string()).optional(),
    checklist: z.array(checklistItemSchema).optional(),
    children: z.array(planStepSchema).optional(),
  })
);

const planSchema = z.object({
  version: z.literal(2).optional(),
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
  beforeCall?: () => void;
  onTrace?: (event: ModelCallTraceEvent) => void;

  constructor(options: PlannerOptions = {}) {
    const runtime = runtimeSettings();
    this.systemPrompt =
      options.systemPrompt ??
      'You are a planning assistant. Break down the user request into clear, executable steps. ' +
      'Each step may optionally use a tool. Respond ONLY with a JSON object matching the requested format. ' +
      runtimePreferenceInstruction(runtime);
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
      'Execution ownership and delegation:\n' +
      '- Use executor "main" by default. The main agent owns user interaction, state changes, synthesis, and the final answer.\n' +
      '- Use executor "subagent" only for a complete, self-contained, read-only work package with a distinct scope and verifiable deliverable.\n' +
      '- A sub-agent work package may contain a "checklist". The checklist belongs to that one sub-agent and MUST NOT become separate plan steps or separate agents.\n' +
      '- Never create a sub-agent merely to read one file, run one search, check one keyword, call one tool, aggregate sibling results, or write the final answer.\n' +
      '- Prefer a few non-overlapping domain or outcome work packages over many narrow operation-level tasks.\n' +
      '- Every sub-agent work package MUST include expectedOutcome, expectedEvidence, delegationReason, and a meaningful checklist.\n' +
      '- Set parallel true only for independent sub-agent work packages. Parallel work MUST be read-only and MUST NOT depend on sibling output.\n' +
      '- Use dependsOn for prerequisites. A step with dependencies is not parallel.\n' +
      '- Do not impose an arbitrary number of sub-agents; create only work packages whose isolation or parallelism materially improves the result.\n\n' +
      'Requirements fidelity:\n' +
      '- If the request explicitly specifies an output file name or location (e.g. "write REPORT.md to the workspace root"), steps MUST use that exact name and location — never invent substitutes.\n' +
      '- Intermediate results produced by earlier steps are available in the conversation context; do NOT assume they exist as files and do NOT plan steps to "find" them.\n\n' +
      'Autonomy:\n' +
      '- Never plan steps that wait for or request user input mid-plan; the plan must run to completion unattended.\n' +
      '- If required information is missing and cannot be obtained with tools, make a reasonable assumption and note it in the final answer instead of stalling.\n\n' +
      'You must respond ONLY with a JSON object matching this exact format, no markdown, no explanation:\n' +
      '{\n' +
      '  "version": 2,\n' +
      '  "reasoning": "brief explanation of the plan",\n' +
      '  "steps": [\n' +
      '    {\n' +
      '      "id": "1",\n' +
      '      "description": "what to do in this work package",\n' +
      '      "executor": "main",\n' +
      '      "toolName": "optional_tool_name",\n' +
      '      "expectedOutcome": "what should happen after this step",\n' +
      '      "parallel": false,\n' +
      '      "dependsOn": [],\n' +
      '      "delegationReason": "required only when executor is subagent",\n' +
      '      "constraints": ["hard requirement"],\n' +
      '      "scope": ["area included in this work package"],\n' +
      '      "nonGoals": ["area owned by another work package"],\n' +
      '      "expectedEvidence": ["concrete evidence to return"],\n' +
      '      "checklist": [\n' +
      '        {\n' +
      '          "id": "1.1",\n' +
      '          "description": "an internal check owned by this one work package"\n' +
      '        }\n' +
      '      ]\n' +
      '    }\n' +
      '  ]\n' +
      '}\n\n' +
      'Example:\n' +
      '{\n' +
      '  "version": 2,\n' +
      '  "reasoning": "Run independent review work packages, then let the main agent verify and synthesize them.",\n' +
      '  "steps": [\n' +
      '    {\n' +
      '      "id": "1",\n' +
      '      "description": "Review architecture and module boundaries",\n' +
      '      "executor": "subagent",\n' +
      '      "parallel": true,\n' +
      '      "delegationReason": "Architecture analysis is an independent evidence-producing direction.",\n' +
      '      "expectedOutcome": "A prioritized architecture review with concrete code locations",\n' +
      '      "expectedEvidence": ["file paths", "line numbers", "dependency relationships"],\n' +
      '      "constraints": ["read-only", "do not cover security or tests"],\n' +
      '      "scope": ["module boundaries", "dependency direction"],\n' +
      '      "nonGoals": ["security risks", "test quality"],\n' +
      '      "checklist": [\n' +
      '        {"id": "1.1", "description": "Identify module boundaries and entry points"},\n' +
      '        {"id": "1.2", "description": "Check coupling and dependency direction"}\n' +
      '      ]\n' +
      '    },\n' +
      '    {\n' +
      '      "id": "2",\n' +
      '      "description": "Verify evidence, remove duplicates, and present the final review",\n' +
      '      "executor": "main",\n' +
      '      "dependsOn": ["1"],\n' +
      '      "expectedOutcome": "A concise evidence-backed final answer"\n' +
      '    }\n' +
      '  ]\n' +
      '}';

    try {
      const raw = await this.callModelWithJsonFormat(prompt);
      return this.parsePlan(raw, userRequest);
    } catch (error) {
      if (error instanceof AgentTokenBudgetExceededError) throw error;
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
    this.beforeCall?.();
    this.onTrace?.({
      type: 'model_call', phase: 'started', modelCallId, purpose: 'planner',
      provider: this.modelProvider.name, model: this.modelProvider.model,
      attempt: 0, streaming: false, startedAt, messageCount: messages.length, toolCount: 0,
      input: { messages, jsonMode: true },
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
        output: {
          content: response.content,
          reasoning: response.reasoning,
          toolCalls: response.toolCalls,
        },
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
        version: 2,
        reasoning: validated.reasoning,
        steps: validated.steps.map((step) => this.prepareStep(step)),
      };
    } catch {
      return this.fallbackPlan(userRequest, 'Plan parsing failed');
    }
  }

  private prepareStep(
    step: RawPlanStep,
    parentId?: string,
    inheritedLegacyParallel = false,
  ): PlanStep {
    const hasChildren = Boolean(step.children?.length);
    const legacyParallel =
      step.executor === undefined &&
      (inheritedLegacyParallel || Boolean(step.parallel));
    const executor: PlanExecutor =
      step.executor ??
      (step.delegate || (!hasChildren && legacyParallel) ? 'subagent' : 'main');
    const prepared: PlanStep = {
      id: step.id,
      description: step.description,
      status: 'pending',
      toolName: step.toolName,
      expectedOutcome: step.expectedOutcome,
      expectedEvidence: step.expectedEvidence,
      constraints: step.constraints,
      scope: step.scope,
      nonGoals: step.nonGoals,
      delegationReason: step.delegationReason,
      executor,
      delegate: executor === 'subagent',
      parallel: executor === 'subagent' && !step.dependsOn?.length
        ? legacyParallel || step.parallel || undefined
        : false,
      dependsOn: step.dependsOn,
      checklist: step.checklist,
      parentId,
    };
    if (step.children?.length) {
      prepared.children = step.children!.map((child) =>
        this.prepareStep(
          child,
          step.id,
          inheritedLegacyParallel ||
            (step.executor === undefined && Boolean(step.parallel)),
        )
      );
    }
    return prepared;
  }

  private fallbackPlan(userRequest: string, error: string): Plan {
    const runtime = runtimeSettings();
    return {
      version: 2,
      reasoning: localizedText(runtime.locale, userRequest, {
        zhCN: `直接回答用户请求。（${error}）`,
        enUS: `Directly respond to the user request. (${error})`,
      }),
      steps: [
        {
          id: '1',
          description: localizedText(runtime.locale, userRequest, {
            zhCN: `回答：${userRequest}`,
            enUS: `Respond to: ${userRequest}`,
          }),
          status: 'pending',
          executor: 'main',
        },
      ],
    };
  }
}
