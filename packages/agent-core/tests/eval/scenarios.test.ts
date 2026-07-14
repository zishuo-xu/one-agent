import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunner } from '../../src/eval/runner.js';
import {
  simpleQaTask,
  readFileTask,
  listThenReadTask,
  writeFileTask,
  invalidArgRetryTask,
  planningTask,
  projectOnboardingTask,
  createTodoTask,
  findAndSummarizeTask,
  multiStepQueryTask,
  refusalTask,
  emptyWorkspaceQueryTask,
  fileNotFoundRecoveryTask,
  summarizeLongFileTask,
  multiToolPlanningTask,
  realModelPlanningTask,
  getTimeTask,
  toolChainTask,
  replanScenarioTask,
  offlineAnswerTask,
} from '../../src/eval/scenarios/index.js';
import { createToolCallResponse, createTextResponse } from '../../src/eval/fixtures.js';

vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
    openai: {
      chat: { completions: { create: vi.fn() } },
    },
  },
}));

import { config } from '../../src/config.js';

const mockCreate = vi.mocked(config.openai.chat.completions.create);

function buildWorkspaceRoot() {
  return mkdtempSync(join(tmpdir(), 'one-agent-eval-'));
}

describe('EvalRunner built-in scenarios', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = buildWorkspaceRoot();
    mockCreate.mockReset();
  });

  it('passes simple-qa', async () => {
    mockCreate.mockResolvedValueOnce(createTextResponse('The capital of France is Paris.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [simpleQaTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes read-file', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.txt' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('The notes mention trace, evaluation, and tests.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [readFileTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes list-then-read', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'list_files', arguments: { path: '' } }]) as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_2', name: 'read_file', arguments: { path: 'report.txt' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('Q3 revenue increased by 12%.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [listThenReadTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes write-file', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'write_file', arguments: { path: 'output.txt', content: 'hello eval' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('Created output.txt with "hello eval".') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [writeFileTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes invalid-arg-retry', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'wrong.txt' } }]) as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_2', name: 'read_file', arguments: { path: 'notes.txt' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('The reminder is to buy milk.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [invalidArgRetryTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes planning', async () => {
    const planResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              reasoning: 'Read the data file.',
              steps: [
                { id: '1', description: 'Read data.txt', toolName: 'read_file', expectedOutcome: 'File content retrieved' },
              ],
            }),
          },
        },
      ],
    };
    const judgeResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({ complete: true, reasoning: 'Done', nextAction: 'finalize' }),
          },
        },
      ],
    };

    mockCreate
      .mockResolvedValueOnce(planResponse as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'data.txt' } }]) as never)
      .mockResolvedValueOnce(judgeResponse as never)
      .mockResolvedValueOnce(createTextResponse('Project status is green.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [planningTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.results[0].events.some((e) => e.type === 'plan')).toBe(true);
  });

  it('passes project-onboarding', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'list_files', arguments: {} }]) as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_2', name: 'read_file', arguments: { path: 'README.md' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('This is one-agent, a simplified agent runtime project.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [projectOnboardingTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes create-todo', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'write_file', arguments: { path: 'todo.md', content: '1. 任务 A\n2. 任务 B\n3. 任务 C' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('Created todo.md with 3 tasks.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [createTodoTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes find-and-summarize', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'src/index.ts' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('This file initializes an AgentLoop and chats with it.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [findAndSummarizeTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes multi-step-query', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'list_files', arguments: {} }]) as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_2', name: 'read_file', arguments: { path: 'notes.txt' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('The first txt file says: Meeting: discuss trace and evaluation.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [multiStepQueryTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes refusal', async () => {
    mockCreate.mockResolvedValueOnce(createTextResponse('I cannot do that because it is dangerous and inappropriate.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [refusalTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes empty-workspace-query', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'list_files', arguments: {} }]) as never)
      .mockResolvedValueOnce(createTextResponse('The workspace is empty. There are no files here.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [emptyWorkspaceQueryTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes file-not-found-recovery', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.md' } }]) as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_2', name: 'list_files', arguments: {} }]) as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_3', name: 'read_file', arguments: { path: 'notes.txt' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('The notes say: discuss idempotency and evaluation.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [fileNotFoundRecoveryTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes summarize-long-file', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'long-report.txt' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('The core idea is to build a single-agent runtime and evaluate its capabilities.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [summarizeLongFileTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes multi-tool-planning', async () => {
    const planResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              reasoning: 'List files then read the first txt.',
              steps: [
                { id: '1', description: 'List txt files', toolName: 'list_files', expectedOutcome: 'File list' },
                { id: '2', description: 'Read first txt file', toolName: 'read_file', expectedOutcome: 'Content retrieved' },
              ],
            }),
          },
        },
      ],
    };
    const continueJudge = {
      choices: [{
        message: {
          content: JSON.stringify({ complete: false, reasoning: 'Need to read file.', nextAction: 'continue' }),
        },
      }],
    };
    const finalizeJudge = {
      choices: [{
        message: {
          content: JSON.stringify({ complete: true, reasoning: 'Done.', nextAction: 'finalize' }),
        },
      }],
    };

    mockCreate
      .mockResolvedValueOnce(planResponse as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'list_files', arguments: {} }]) as never)
      .mockResolvedValueOnce(continueJudge as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_2', name: 'read_file', arguments: { path: 'notes.txt' } }]) as never)
      .mockResolvedValueOnce(finalizeJudge as never)
      .mockResolvedValueOnce(createTextResponse('The notes mention finishing evaluation and adding idempotency.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [multiToolPlanningTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.results[0].events.some((e) => e.type === 'plan')).toBe(true);
  });

  it('passes real-model-planning in mock mode', async () => {
    const planResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              reasoning: 'Read notes.txt to answer.',
              steps: [
                { id: '1', description: 'Read notes.txt', toolName: 'read_file', expectedOutcome: 'Content retrieved' },
              ],
            }),
          },
        },
      ],
    };
    const judgeResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({ complete: true, reasoning: 'Done', nextAction: 'finalize' }),
          },
        },
      ],
    };

    mockCreate
      .mockResolvedValueOnce(planResponse as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.txt' } }]) as never)
      .mockResolvedValueOnce(judgeResponse as never)
      .mockResolvedValueOnce(createTextResponse('The main topic is artificial intelligence and software engineering.') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [realModelPlanningTask], workspaceRoot, mode: 'mock' });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.results[0].events.some((e) => e.type === 'plan')).toBe(true);
    expect(summary.results[0].planningMetrics).toBeDefined();
    expect(summary.results[0].planningMetrics?.planStepCount).toBe(1);
  });

  it('passes get-time (tool call to get_time)', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'get_time', arguments: {} }]) as never)
      .mockResolvedValueOnce(createTextResponse('当前时间是 14:30。') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [getTimeTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('passes tool-chain (read_file then write_file in order)', async () => {
    mockCreate
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_1', name: 'read_file', arguments: { path: 'source.txt' } }]) as never)
      .mockResolvedValueOnce(createToolCallResponse([{ id: 'call_2', name: 'write_file', arguments: { path: 'copy.txt', content: 'Hello from source file.' } }]) as never)
      .mockResolvedValueOnce(createTextResponse('已将内容写入 copy.txt。') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [toolChainTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    // Verify copy.txt was created with correct content
    const fs = await import('node:fs');
    const copyPath = join(workspaceRoot, 'copy.txt');
    expect(fs.existsSync(copyPath)).toBe(true);
    expect(fs.readFileSync(copyPath, 'utf-8')).toContain('Hello from source file.');
  });

  it('passes replan-scenario (plan fails, agent replans and succeeds)', async () => {
    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [replanScenarioTask], workspaceRoot, mode: 'mock' });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    // Should have at least 2 plan events (original + replan)
    expect(summary.results[0].planningMetrics?.planCount).toBeGreaterThanOrEqual(2);
    expect(summary.results[0].planningMetrics?.replanCount).toBeGreaterThanOrEqual(1);
  });

  it('passes offline-answer (no tools used, knowledge only)', async () => {
    mockCreate.mockResolvedValueOnce(createTextResponse('水的沸点在标准大气压下是 100 摄氏度。') as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [offlineAnswerTask], workspaceRoot });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('tracks token usage from mock responses', async () => {
    mockCreate
      .mockResolvedValueOnce({
        ...createTextResponse('水的沸点是 100 度。'),
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      } as never);

    const runner = new EvalRunner();
    const summary = await runner.run({ tasks: [offlineAnswerTask], workspaceRoot });

    expect(summary.results[0].tokenUsage).toBeDefined();
    expect(summary.results[0].tokenUsage?.totalTokens).toBe(100);
  });
});
