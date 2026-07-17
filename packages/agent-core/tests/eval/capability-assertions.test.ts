import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunner } from '../../src/eval/runner.js';
import {
  assertFinalAnswerContainsAll,
  assertFinalAnswerNotContains,
} from '../../src/eval/assertions.js';
import { createTextResponse, createToolCallResponse } from '../../src/eval/fixtures.js';
import type { EvalTask } from '../../src/eval/types.js';

describe('answer assertion helpers', () => {
  it('assertFinalAnswerContainsAll passes only when every phrase appears (case-insensitive)', () => {
    expect(
      assertFinalAnswerContainsAll('The new TIMEOUT is 3000 ms', ['3000', 'timeout']),
    ).toBeUndefined();
    expect(assertFinalAnswerContainsAll('The value is 3000', ['3000', '9999'])).toContain('9999');
  });

  it('assertFinalAnswerNotContains fails when a forbidden phrase appears (case-insensitive)', () => {
    expect(assertFinalAnswerNotContains('All Tests Passed', ['tests passed'])).toContain(
      'tests passed',
    );
    expect(
      assertFinalAnswerNotContains('npm exited with code 1: missing package.json', ['tests passed']),
    ).toBeUndefined();
  });
});

describe('EvalRunner capability assertions', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'one-agent-eval-cap-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('passes when combined answer/file/tool expectations are all satisfied', async () => {
    const task: EvalTask = {
      id: 'cap-timeout-double',
      name: 'capability: timeout double',
      description: 'read config, double timeout, write new file.',
      prompt: 'Double the timeout.',
      initialWorkspace: { 'config.json': '{"timeout": 1500}' },
      requiredTools: [{ name: 'read_file' }, { name: 'write_file' }],
      finalAnswerContainsAll: ['3000'],
      expectedFiles: [{ path: 'timeout_new.txt', containsAll: ['3000'], notContains: ['1500'] }],
      capabilities: ['tool-chain'],
      difficulty: 'easy',
      mockResponses: [
        createToolCallResponse([{ id: 'c1', name: 'read_file', arguments: { path: 'config.json' } }]),
        createToolCallResponse([
          { id: 'c2', name: 'write_file', arguments: { path: 'timeout_new.txt', content: '3000' } },
        ]),
        createTextResponse('新的 timeout 是 3000。'),
      ],
    };

    const summary = await new EvalRunner().run({ tasks: [task], workspaceRoot, mode: 'mock' });

    expect(summary.passed).toBe(1);
    expect(summary.results[0].errors).toEqual([]);
  });

  it('fails when the final answer contains a forbidden phrase', async () => {
    const task: EvalTask = {
      id: 'cap-no-fake-success',
      name: 'capability: no fabricated success',
      description: 'the answer must not claim success.',
      prompt: 'Run npm test.',
      finalAnswerNotContains: ['测试全部通过'],
      mockResponses: [createTextResponse('测试全部通过，没有问题。')],
    };

    const summary = await new EvalRunner().run({ tasks: [task], workspaceRoot, mode: 'mock' });

    expect(summary.failed).toBe(1);
    expect(summary.results[0].errors.join(' ')).toContain('测试全部通过');
  });

  it('fails when a forbidden file exists after the run', async () => {
    const task: EvalTask = {
      id: 'cap-forbidden-file',
      name: 'capability: forbidden leftover file',
      description: 'a file that should have been deleted still exists.',
      prompt: 'Write junk.txt.',
      forbiddenFiles: ['junk.txt'],
      mockResponses: [
        createToolCallResponse([
          { id: 'c1', name: 'write_file', arguments: { path: 'junk.txt', content: 'x' } },
        ]),
        createTextResponse('done'),
      ],
    };

    const summary = await new EvalRunner().run({ tasks: [task], workspaceRoot, mode: 'mock' });

    expect(summary.failed).toBe(1);
    expect(summary.results[0].errors.join(' ')).toContain('junk.txt');
  });

  it('runs each task in an isolated workspace directory (no cross-task leakage)', async () => {
    // Regression: tasks used to share one workspace root, so files written by
    // one task polluted the next task's view.
    const writer: EvalTask = {
      id: 'cap-writer',
      name: 'writer',
      description: 'writes secret.txt',
      prompt: 'Write a file.',
      mockResponses: [
        createToolCallResponse([
          { id: 'c1', name: 'write_file', arguments: { path: 'secret.txt', content: 's3cret' } },
        ]),
        createTextResponse('written'),
      ],
    };
    const reader: EvalTask = {
      id: 'cap-reader',
      name: 'reader',
      description: 'must not see writer output',
      prompt: 'Look around.',
      forbiddenFiles: ['secret.txt'],
      mockResponses: [createTextResponse('workspace is clean')],
    };

    const summary = await new EvalRunner().run({
      tasks: [writer, reader],
      workspaceRoot,
      mode: 'mock',
    });

    expect(summary.passed).toBe(2);
    expect(existsSync(join(workspaceRoot, 'cap-writer', 'secret.txt'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'cap-reader', 'secret.txt'))).toBe(false);
  });

  it('awards partial credit per checkpoint and sums scores in the summary', async () => {
    const task: EvalTask = {
      id: 'cap-weekly',
      name: 'capability: weekly report with checkpoints',
      description: 'two checkpoints pass, one fails.',
      prompt: 'Summarize into weekly.md.',
      checkpoints: [
        {
          id: 'report-file',
          description: 'weekly.md exists with both sections',
          points: 2,
          expectedFiles: [{ path: 'weekly.md', containsAll: ['完成', '风险'] }],
        },
        {
          id: 'counts',
          description: 'answer states the counts',
          points: 1,
          finalAnswerContainsAll: ['3', '1'],
        },
        {
          id: 'missing',
          description: 'summary.txt exists (mock never writes it)',
          points: 1,
          expectedFiles: [{ path: 'summary.txt' }],
        },
      ],
      mockResponses: [
        createToolCallResponse([
          {
            id: 'c1',
            name: 'write_file',
            arguments: { path: 'weekly.md', content: '# 周报\n## 完成\n- A\n## 风险\n- R1' },
          },
        ]),
        createTextResponse('本周完成 3 项，风险 1 项。'),
      ],
    };

    const summary = await new EvalRunner().run({ tasks: [task], workspaceRoot, mode: 'mock' });
    const result = summary.results[0];

    expect(result.passed).toBe(false);
    expect(result.score).toBe(3);
    expect(result.maxScore).toBe(4);
    expect(result.checkpointResults).toHaveLength(3);
    expect(result.checkpointResults?.find((c) => c.id === 'missing')?.earned).toBe(0);
    expect(result.checkpointResults?.find((c) => c.id === 'report-file')?.earned).toBe(2);
    expect(summary.totalScore).toBe(3);
    expect(summary.totalMaxScore).toBe(4);
  });

  it('passes a checkpoint task with full score', async () => {
    const task: EvalTask = {
      id: 'cap-full-score',
      name: 'capability: full checkpoint score',
      description: 'single checkpoint, satisfied.',
      prompt: 'Say ok.',
      checkpoints: [
        {
          id: 'answer',
          description: 'answer says ok',
          points: 1,
          finalAnswerContains: ['ok'],
        },
      ],
      mockResponses: [createTextResponse('ok')],
    };

    const summary = await new EvalRunner().run({ tasks: [task], workspaceRoot, mode: 'mock' });

    expect(summary.passed).toBe(1);
    expect(summary.results[0].score).toBe(1);
    expect(summary.results[0].maxScore).toBe(1);
  });
});
