import { config } from '../config.js';

export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface AgentLoopOptions {
  systemPrompt?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export class AgentLoop {
  private messages: Message[] = [];
  private readonly systemPrompt: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: AgentLoopOptions = {}) {
    this.systemPrompt = options.systemPrompt ?? config.systemPrompt;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.messages.push({ role: 'system', content: this.systemPrompt });
  }

  async chat(message: string): Promise<string> {
    this.messages.push({ role: 'user', content: message });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await config.openai.chat.completions.create(
          {
            model: config.model,
            messages: this.messages,
          },
          { timeout: this.timeoutMs }
        );

        const content = response.choices[0]?.message?.content ?? '';
        this.messages.push({ role: 'assistant', content });
        return content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === this.maxRetries) {
          break;
        }
      }
    }

    throw new Error(
      `AgentLoop failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message}`
    );
  }

  getHistory(): Message[] {
    return [...this.messages];
  }
}
