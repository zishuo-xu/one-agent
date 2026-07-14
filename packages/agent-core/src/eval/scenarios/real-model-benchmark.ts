import { EvalTask } from '../types.js';

/**
 * A broader real-model benchmark scenario: the agent must use a tool (read_file)
 * to answer a question about a seeded file, then provide a concise summary.
 * Uses requiredTools (order-agnostic) so it works with non-deterministic real models.
 */
export const realModelBenchmarkTask: EvalTask = {
  id: 'real-model-benchmark',
  name: 'Real model benchmark: tool use + summarization',
  description: 'A scenario for real-model evaluation: read a file and summarize its main points.',
  prompt: '读取 config.md 文件，然后用中文总结它的三个要点。',
  initialWorkspace: {
    'config.md': [
      '# Configuration',
      '',
      '## API Settings',
      '- OPENAI_API_KEY: your API key',
      '- OPENAI_BASE_URL: endpoint URL',
      '- OPENAI_MODEL: model name (default gpt-3.5-turbo)',
      '',
      '## Timeout',
      '- OPENAI_TIMEOUT_MS: per-request timeout in ms (default 30000)',
      '',
      '## Search',
      '- SEARCH_API_URL: optional search API endpoint',
      '- SEARCH_API_KEY: optional search API key',
    ].join('\n'),
  },
  requiredTools: [{ name: 'read_file' }],
  finalAnswerContains: ['API', 'config', '配置', 'timeout', '超时', 'search', '搜索'],
  enablePlanning: false,
  timeoutMs: 120000,
};
