import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../src/config.js', () => ({
  config: {
    port: 3000,
    host: '127.0.0.1',
    model: 'gpt-test',
    systemPrompt: 'You are a test assistant.',
    timeoutMs: 30000,
    openai: { chat: { completions: { create: vi.fn() } } },
  },
}));

import { AgentLoop } from '../src/agents/AgentLoop.js';
import type { RunCheckpoint } from '../src/agents/checkpoint.js';
import { createConnection } from '../src/db/connection.js';
import { RunStore } from '../src/db/runStore.js';
import { ThreadStore } from '../src/db/threadStore.js';
import { MockProvider } from '../src/model/MockProvider.js';
import { ToolRegistry } from '../src/tools/registry.js';

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    originalMessage: 'Read the files and report back.',
    loopMode: 'planning',
    plan: {
      reasoning: 'Read two files.',
      steps: [
        { id: '1', description: 'Read first file', toolName: 'read_file', status: 'completed' },
        { id: '2', description: 'Read second file', toolName: 'read_file', status: 'pending' },
      ],
    },
    currentUnitIndex: 1,
    replanAttempts: 0,
    retryAttempts: 0,
    recoveryCount: 0,
    ...overrides,
  };
}

describe('PlanningLoop checkpoint recovery', () => {
  it('persists the active tool before awaiting its result', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'checkpoint-thread' }).id;
    const runStore = new RunStore(db);
    let releaseTool!: () => void;
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
    const tools = new ToolRegistry();
    tools.register({
      name: 'write_file',
      description: 'Write a file',
      parameters: z.object({ path: z.string(), content: z.string() }),
      execute: async () => {
        markToolStarted();
        await new Promise<void>((resolve) => { releaseTool = resolve; });
        return { written: true };
      },
    });
    const provider = new MockProvider([
      {
        choices: [{ message: { content: JSON.stringify({
          reasoning: 'Write once',
          steps: [{ id: '1', description: 'Write output', toolName: 'write_file' }],
        }) } }],
      },
      {
        choices: [{ message: {
          content: 'Writing.',
          tool_calls: [{
            id: 'write-call',
            function: { name: 'write_file', arguments: '{"path":"out.txt","content":"done"}' },
          }],
        } }],
      },
      { choices: [{ message: { content: 'Written.' } }] },
    ]);
    const agent = new AgentLoop({
      threadId,
      db,
      tools,
      modelProvider: provider,
      enablePlanning: true,
      subAgents: false,
    });

    const running = agent.chat('Write the output');
    await toolStarted;

    const inProgress = runStore.getByThread(threadId)[0];
    expect(inProgress.status).toBe('running');
    expect(inProgress.traceStatus).toBe('recording');
    expect(inProgress.checkpoint?.plan.steps[0].status).toBe('running');
    expect(inProgress.checkpoint?.activeToolCall).toMatchObject({
      id: 'write-call',
      status: 'running',
      recoveryPolicy: 'verify_before_retry',
    });

    releaseTool();
    const result = await running;
    const completed = runStore.getById(result.runId!);
    expect(completed?.status).toBe('completed');
    expect(completed?.checkpoint?.plan.steps[0].status).toBe('completed');
    expect(completed?.checkpoint?.activeToolCall).toBeUndefined();
  });

  it('resumes from the first incomplete step without replaying completed work', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'recovery-thread' }).id;
    const runStore = new RunStore(db);
    const oldRun = runStore.create({
      threadId,
      model: 'mock-model',
      status: 'running',
      checkpoint: checkpoint(),
    });
    const readFile = vi.fn(() => ({ content: 'second file' }));
    const tools = new ToolRegistry();
    tools.register({
      name: 'read_file',
      description: 'Read a file',
      parameters: z.object({ path: z.string() }),
      execute: readFile,
    });
    const provider = new MockProvider([
      {
        choices: [{
          message: {
            content: 'Reading the remaining file.',
            tool_calls: [{
              id: 'resume-call',
              function: { name: 'read_file', arguments: '{"path":"second.txt"}' },
            }],
          },
        }],
      },
      { choices: [{ message: { content: 'Recovery completed.' } }] },
    ]);
    const agent = new AgentLoop({
      threadId,
      db,
      tools,
      modelProvider: provider,
      enablePlanning: true,
      subAgents: false,
    });

    const result = await agent.resumeRun(oldRun.id);

    expect(result.reply).toBe('Recovery completed.');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith({ path: 'second.txt' });
    expect(runStore.getById(oldRun.id)?.status).toBe('interrupted');
    const resumed = runStore.getById(result.runId!);
    expect(resumed?.status).toBe('completed');
    expect(resumed?.checkpoint?.resumedFromRunId).toBe(oldRun.id);
    expect(resumed?.checkpoint?.recoveryCount).toBe(1);
    expect(resumed?.checkpoint?.plan.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('refuses to replay an uncertain side-effecting tool', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'unsafe-recovery-thread' }).id;
    const runStore = new RunStore(db);
    const unsafeCheckpoint = checkpoint({
      activeToolCall: {
        id: 'append-call',
        name: 'append_file',
        stepId: '2',
        arguments: { path: 'notes.txt', content: 'line' },
        status: 'running',
        recoveryPolicy: 'manual',
      },
    });
    const oldRun = runStore.create({
      threadId,
      model: 'mock-model',
      status: 'running',
      checkpoint: unsafeCheckpoint,
    });
    const agent = new AgentLoop({
      threadId,
      db,
      tools: new ToolRegistry(),
      modelProvider: new MockProvider([]),
      enablePlanning: true,
      subAgents: false,
    });

    await expect(agent.resumeRun(oldRun.id)).rejects.toThrow('cannot be replayed automatically');
    expect(runStore.getById(oldRun.id)?.status).toBe('recovery_required');
    expect(runStore.getByThread(threadId)).toHaveLength(1);
  });
});
