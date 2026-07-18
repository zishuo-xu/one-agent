import { describe, expect, it, vi } from 'vitest';

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
import { createRequestUserInputTool } from '../src/agents/requestUserInputTool.js';
import { createConnection } from '../src/db/connection.js';
import { RunStore } from '../src/db/runStore.js';
import { ThreadStore } from '../src/db/threadStore.js';
import { MockProvider } from '../src/model/MockProvider.js';
import { ToolRegistry } from '../src/tools/registry.js';

function inputTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(createRequestUserInputTool());
  return tools;
}

describe('durable user-input continuation', () => {
  it('persists a question and continues it from a new AgentLoop instance', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'input-thread' }).id;
    const runStore = new RunStore(db);
    const firstAgent = new AgentLoop({
      threadId,
      db,
      tools: inputTools(),
      modelProvider: new MockProvider([{
        choices: [{ message: {
          content: '',
          tool_calls: [{
            id: 'ask-1',
            function: {
              name: 'request_user_input',
              arguments: JSON.stringify({ question: 'Which environment?', options: ['staging', 'production'] }),
            },
          }],
        } }],
      }]),
      enablePlanning: false,
      subAgents: false,
    });

    const waitingResult = await firstAgent.chat('Deploy the service');
    expect(waitingResult).toMatchObject({
      status: 'waiting_for_input',
      reply: 'Which environment?',
    });
    const waitingRun = runStore.getWaitingByThread(threadId);
    expect(waitingRun?.checkpoint).toMatchObject({
      loopMode: 'simple',
      originalMessage: 'Deploy the service',
      pendingInput: { question: 'Which environment?' },
    });

    const reopenedAgent = new AgentLoop({
      threadId,
      db,
      tools: inputTools(),
      modelProvider: new MockProvider([
        { choices: [{ message: { content: 'Deploying to staging.' } }] },
      ]),
      enablePlanning: false,
      subAgents: false,
    });
    const completed = await reopenedAgent.continueRun(waitingRun!.id, 'staging');

    expect(completed).toMatchObject({ status: 'completed', reply: 'Deploying to staging.' });
    expect(runStore.getById(waitingRun!.id)?.status).toBe('interrupted');
    expect(runStore.getById(completed.runId!)?.status).toBe('completed');
    expect(reopenedAgent.getHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Which environment?' }),
      expect.objectContaining({ role: 'user', content: 'staging' }),
    ]));
    await expect(reopenedAgent.continueRun(waitingRun!.id, 'production'))
      .rejects.toThrow('not waiting for user input');
    db.close();
  });

  it('cancels a waiting run without creating another run', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'cancel-thread' }).id;
    const runStore = new RunStore(db);
    const run = runStore.create({
      threadId,
      model: 'mock',
      status: 'waiting_for_input',
      checkpoint: {
        version: 1,
        updatedAt: new Date().toISOString(),
        originalMessage: 'Do it',
        loopMode: 'simple',
        recoveryCount: 0,
        pendingInput: {
          id: 'request-1',
          question: 'Which target?',
          createdAt: new Date().toISOString(),
        },
      },
    });
    const agent = new AgentLoop({
      threadId,
      db,
      tools: inputTools(),
      modelProvider: new MockProvider([]),
      enablePlanning: false,
      subAgents: false,
    });

    expect(agent.cancelWaitingRun(run.id)).toBe(true);
    expect(agent.cancelWaitingRun(run.id)).toBe(false);
    expect(runStore.getById(run.id)?.status).toBe('cancelled');
    expect(runStore.getByThread(threadId)).toHaveLength(1);
    db.close();
  });

  it('resumes the same pending planning step after receiving an answer', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'planning-input-thread' }).id;
    const runStore = new RunStore(db);
    const firstAgent = new AgentLoop({
      threadId,
      db,
      tools: inputTools(),
      modelProvider: new MockProvider([
        { choices: [{ message: { content: JSON.stringify({
          reasoning: 'Need the target first.',
          steps: [{
            id: '1',
            description: 'Clarify and use the deployment target',
            toolName: 'request_user_input',
          }],
        }) } }] },
        { choices: [{ message: {
          content: '',
          tool_calls: [{
            id: 'planning-ask',
            function: {
              name: 'request_user_input',
              arguments: JSON.stringify({ question: 'Which deployment target?' }),
            },
          }],
        } }] },
      ]),
      enablePlanning: true,
      subAgents: false,
    });

    const waiting = await firstAgent.chat('Deploy the application');
    expect(waiting.status).toBe('waiting_for_input');
    const checkpoint = runStore.getById(waiting.runId!)?.checkpoint;
    expect(checkpoint?.loopMode).toBe('planning');
    if (checkpoint?.loopMode === 'planning') {
      expect(checkpoint.plan.steps[0].status).toBe('pending');
      expect(checkpoint.currentUnitIndex).toBe(0);
    }

    const reopenedAgent = new AgentLoop({
      threadId,
      db,
      tools: inputTools(),
      modelProvider: new MockProvider([
        { choices: [{ message: { content: 'The target is staging.' } }] },
        { choices: [{ message: { content: 'Deployment target confirmed: staging.' } }] },
      ]),
      enablePlanning: true,
      subAgents: false,
    });
    const completed = await reopenedAgent.continueRun(waiting.runId!, 'staging');

    expect(completed).toMatchObject({
      status: 'completed',
      reply: 'Deployment target confirmed: staging.',
    });
    const finalCheckpoint = runStore.getById(completed.runId!)?.checkpoint;
    expect(finalCheckpoint?.pendingInput).toBeUndefined();
    db.close();
  });
});
