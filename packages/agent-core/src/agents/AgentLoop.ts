import { config } from '../config.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolCall, ToolResult } from '../tools/types.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface AgentLoopOptions {
  systemPrompt?: string;
  maxRetries?: number;
  timeoutMs?: number;
  maxToolIterations?: number;
  tools?: ToolRegistry;
}

export interface AgentLoopEvent {
  type: 'tool_call' | 'tool_result' | 'message';
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  content?: string;
}

export class AgentLoop {
  private messages: Message[] = [];
  private readonly systemPrompt: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private events: AgentLoopEvent[] = [];

  constructor(options: AgentLoopOptions = {}) {
    this.systemPrompt = options.systemPrompt ?? config.systemPrompt;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxToolIterations = options.maxToolIterations ?? 5;
    this.toolRegistry = options.tools;
    this.toolExecutor = this.toolRegistry ? new ToolExecutor(this.toolRegistry) : undefined;
    this.messages.push({ role: 'system', content: this.systemPrompt });
  }

  async chat(message: string): Promise<{ reply: string; events: AgentLoopEvent[] }> {
    this.messages.push({ role: 'user', content: message });
    this.events = [];

    let toolIterations = 0;

    while (toolIterations <= this.maxToolIterations) {
      const response = await this.callModel();
      const assistantMessage = response.choices[0]?.message;

      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCalls = assistantMessage.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: this.safeParseArgs(tc.function.arguments),
        }));

        this.messages.push({
          role: 'assistant',
          content: assistantMessage.content ?? '',
          tool_calls: assistantMessage.tool_calls,
        });

        for (const call of toolCalls) {
          this.events.push({ type: 'tool_call', toolCall: call });

          if (!this.toolExecutor) {
            const result: ToolResult = {
              success: false,
              error: 'No tool executor available',
            };
            this.events.push({ type: 'tool_result', toolResult: result });
            this.messages.push({
              role: 'tool',
              content: JSON.stringify(result),
              tool_call_id: call.id,
            });
            continue;
          }

          const result = await this.toolExecutor.execute(call);
          this.events.push({ type: 'tool_result', toolResult: result });
          this.messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: call.id,
          });
        }

        toolIterations++;
        continue;
      }

      const content = assistantMessage?.content ?? '';
      this.messages.push({ role: 'assistant', content });
      this.events.push({ type: 'message', content });
      return { reply: content, events: this.events };
    }

    throw new Error(
      `AgentLoop stopped after ${this.maxToolIterations + 1} tool iteration(s) without a final answer`
    );
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  getEvents(): AgentLoopEvent[] {
    return [...this.events];
  }

  private async callModel() {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: this.messages as never,
            tools: this.toolRegistry?.getSchemas(),
          },
          { timeout: this.timeoutMs }
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `Model call failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  private safeParseArgs(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
