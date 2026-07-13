const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_ESCAPE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

export function sanitizeTerminalText(value: string): string {
  return value.replace(ANSI_ESCAPE, '').replace(OSC_ESCAPE, '').replace(ZERO_WIDTH, '');
}

export function isRenderableMessageDelta(content: string): boolean {
  return sanitizeTerminalText(content).trim().length > 0;
}

export function shouldPrintFinalReply(reply: string, streamedContent: string): boolean {
  const cleanReply = sanitizeTerminalText(reply).trim();
  const cleanStream = sanitizeTerminalText(streamedContent).trim();
  return cleanReply.length > 0 && cleanReply !== cleanStream;
}
