import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printStartup, HELP_TEXT } from '../src/help.js';
import { categorizeError } from '../src/errors.js';
import { renderMarkdown } from '../src/markdown.js';
import { supportsColor, formatRelativeTime, formatDuration, shortId } from '../src/format.js';

describe('startup banner', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('prints "已创建会话" with short id', () => {
    printStartup('8e0208da-1234-5678', 'created');
    const first = logSpy.mock.calls[0][0] as string;
    expect(first).toContain('已创建会话');
    expect(first).toContain('8e0208da');
  });

  it('prints "已恢复会话" when resuming', () => {
    printStartup('f06e447d-abcd', 'resumed');
    const first = logSpy.mock.calls[0][0] as string;
    expect(first).toContain('已恢复会话');
  });

  it('defaults to created mode', () => {
    printStartup('abcdef12');
    expect(logSpy.mock.calls[0][0]).toContain('已创建会话');
  });
});

describe('help text', () => {
  it('documents --workspace', () => {
    expect(HELP_TEXT).toContain('--workspace');
  });

  it('documents --new (resume most recent by default)', () => {
    expect(HELP_TEXT).toMatch(/--new\b/);
  });

  it('presents one default command and one unified loop option', () => {
    expect(HELP_TEXT).toContain('one-agent trace');
    expect(HELP_TEXT).toContain('--loop <mode>');
    expect(HELP_TEXT).toContain('auto (default), simple, or planning');
    expect(HELP_TEXT).toContain('Deprecated alias for --loop planning');
  });

  it('documents /help', () => {
    expect(HELP_TEXT).toContain('/help');
  });

  it('documents reasoning visibility and verbose context', () => {
    expect(HELP_TEXT).toContain('/context --verbose');
    expect(HELP_TEXT).toContain('PlanningLoop reasoning');
    expect(HELP_TEXT).toContain('Model reasoning is always recorded in Trace');
  });
});

describe('error categorization', () => {
  it('suggests OPENAI_TIMEOUT_MS on timeout errors', () => {
    const err = categorizeError(new Error('Request timed out after 30000ms'));
    expect(err.detail).toContain('OPENAI_TIMEOUT_MS');
    expect(err.detail).toContain('30000');
  });

  it('points to API key on 401', () => {
    const err = categorizeError(new Error('401 Unauthorized'));
    expect(err.detail).toContain('OPENAI_API_KEY');
  });

  it('points to BASE_URL and model on 404', () => {
    const err = categorizeError(new Error('404 model_not_found'));
    expect(err.detail).toContain('OPENAI_BASE_URL');
    expect(err.detail).toContain('OPENAI_MODEL');
  });

  it('suggests wait time on 429 with retry-after', () => {
    const err = categorizeError(new Error('429 Rate limit exceeded. retry after 7'));
    expect(err.detail).toContain('7');
    expect(err.summary).toContain('限流');
  });

  it('includes runId hint when provided', () => {
    const err = categorizeError(new Error('Request timed out'), 'run-abc');
    expect(err.traceHint).toContain('run-abc');
  });
});

describe('markdown renderer', () => {
  it('renders bold', () => {
    expect(renderMarkdown('hello **world**')).toContain('hello');
    // bold content preserved
    expect(renderMarkdown('hello **world**')).toContain('world');
  });

  it('renders headings', () => {
    const out = renderMarkdown('# Title');
    expect(out).not.toMatch(/^#\s/);
    expect(out).toContain('Title');
  });

  it('renders unordered list bullets', () => {
    const out = renderMarkdown('- one\n- two');
    expect(out).toContain('• one');
    expect(out).toContain('• two');
  });

  it('renders ordered list', () => {
    const out = renderMarkdown('1. one\n2. two');
    expect(out).toContain('1. one');
    expect(out).toContain('2. two');
  });

  it('renders code block with boundary', () => {
    const out = renderMarkdown('```js\nconst x = 1;\n```');
    expect(out).toContain('const x = 1');
    expect(out).toContain('─');
  });

  it('renders inline code', () => {
    const out = renderMarkdown('use `foo` here');
    expect(out).toContain('foo');
  });

  it('passes through unsupported markdown without errors', () => {
    const out = renderMarkdown('some > weird > text');
    expect(out).toContain('weird');
  });
});

describe('format helpers', () => {
  it('shortId returns first 8 chars', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567');
  });

  it('formatDuration formats ms and seconds', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('formatRelativeTime returns "刚刚"', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('刚刚');
  });

  it('supportsColor is defined (truthy or false)', () => {
    expect(supportsColor).toBeDefined();
  });
});
