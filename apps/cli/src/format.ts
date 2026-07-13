import process from 'node:process';

export const supportsColor = Boolean(!process.env.NO_COLOR && process.stdout.isTTY);

export function color(code: string, text: string): string {
  if (!supportsColor) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const bold = (text: string) => color('1', text);
export const dim = (text: string) => color('2', text);
export const red = (text: string) => color('31', text);
export const green = (text: string) => color('32', text);
export const yellow = (text: string) => color('33', text);
export const blue = (text: string) => color('34', text);
export const cyan = (text: string) => color('36', text);

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return date.toLocaleDateString('zh-CN');
}

export function padEnd(text: string, width: number): string {
  const len = Array.from(text).length;
  if (len >= width) return text;
  return text + ' '.repeat(width - len);
}
