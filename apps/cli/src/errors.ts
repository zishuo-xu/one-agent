import { red, yellow, dim } from './format.js';

export interface CategorizedError {
  summary: string;
  detail: string;
  traceHint?: string;
}

export function categorizeError(error: unknown, runId?: string, verbose = false): CategorizedError {
  const message = error instanceof Error ? error.message : String(error);
  const original = error instanceof Error ? error.stack ?? message : message;

  // Network / timeout
  if (
    message.includes('timeout') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('fetch failed') ||
    message.includes('Request timed out')
  ) {
    return {
      summary: red('请求超时或网络失败'),
      detail: '请检查网络连接，或增加 OPENAI_TIMEOUT_MS（当前默认 30000ms）。',
      traceHint: runId ? `可执行 /traces ${runId} 查看详情。` : undefined,
    };
  }

  // 401 / 403
  if (message.includes('401') || message.includes('403') || message.includes('Unauthorized') || message.includes('Forbidden')) {
    return {
      summary: red('API 认证失败'),
      detail: '请检查 OPENAI_API_KEY 是否正确，以及该 key 是否有权限访问所选模型。',
      traceHint: runId ? `详细错误：/traces ${runId}` : undefined,
    };
  }

  // 404
  if (message.includes('404') || message.includes('Not Found') || message.includes('model_not_found')) {
    return {
      summary: red('模型或接口不存在'),
      detail: '请检查 OPENAI_BASE_URL 和 OPENAI_MODEL 是否正确。',
      traceHint: runId ? `详细错误：/traces ${runId}` : undefined,
    };
  }

  // 429
  const rateLimitMatch = message.match(/retry after (\d+)/i);
  if (message.includes('429') || message.includes('Rate limit') || message.includes('rate limit')) {
    return {
      summary: red('请求被限流'),
      detail: rateLimitMatch
        ? `触发限流，建议等待 ${rateLimitMatch[1]} 秒后重试。`
        : '触发限流，请稍后重试或降低请求频率。',
      traceHint: runId ? `详细错误：/traces ${runId}` : undefined,
    };
  }

  // Cancelled by user
  if (message === 'AgentLoop was cancelled') {
    return {
      summary: yellow('当前回合已中断'),
      detail: '已取消模型请求，可继续输入。',
    };
  }

  // Default: keep original in verbose, show simplified otherwise
  return {
    summary: red('出错了'),
    detail: verbose ? original : message.slice(0, 200),
    traceHint: runId ? `可执行 /traces ${runId} 查看详情。` : undefined,
  };
}

export function printError(error: CategorizedError, verbose: boolean): void {
  console.error(`\n${error.summary}`);
  if (error.detail) console.error(dim(error.detail));
  if (error.traceHint) console.error(dim(error.traceHint));
  if (verbose) {
    console.error(dim('（verbose 模式已输出完整错误信息）'));
  }
}
