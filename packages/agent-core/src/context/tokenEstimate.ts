import { Message } from '../agents/types.js';

/**
 * Estimate the number of tokens in a text string using a lightweight heuristic.
 *
 * No external tokenizer dependency is required. The estimate is intentionally
 * approximate but reasonable for mixed CJK/ASCII content:
 * - CJK characters (Chinese, Japanese, Korean): ~1 token per character
 * - ASCII characters: ~4 characters per token
 * - Other characters: ~2 characters per token
 *
 * For GLM-5.2 and OpenAI models this gives a conservative (slightly over) estimate,
 * which is safe for context-window budgeting.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let ascii = 0;
  let other = 0;

  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
      (code >= 0xac00 && code <= 0xd7af) || // Hangul
      (code >= 0x3400 && code <= 0x4dbf) // CJK Extension A
    ) {
      cjk++;
    } else if (code < 0x80) {
      ascii++;
    } else {
      other++;
    }
  }

  return Math.ceil(cjk + ascii / 4 + other / 2);
}

/** Per-message overhead for role/metadata (~4 tokens). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimate the token cost of a single Message, including its content,
 * tool_calls, and structural overhead.
 */
export function estimateMessageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD_TOKENS;

  if (message.content) {
    total += estimateTokens(message.content);
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      total += estimateTokens(tc.function.name);
      total += estimateTokens(tc.function.arguments);
      total += MESSAGE_OVERHEAD_TOKENS; // id + type overhead
    }
  }

  if (message.tool_call_id) {
    total += estimateTokens(message.tool_call_id);
  }

  return total;
}

/** Estimate total tokens across an array of messages. */
export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
