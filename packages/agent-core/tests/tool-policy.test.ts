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
import { createConnection } from '../src/db/connection.js';
import { RunStore } from '../src/db/runStore.js';
import { ThreadStore } from '../src/db/threadStore.js';
import { MockProvider } from '../src/model/MockProvider.js';
import {
  DefaultToolPolicy,
  fingerprintToolCall,
} from '../src/tools/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';

function deleteTools(execute: () => unknown): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: 'delete_file',
    description: 'Delete a file',
    parameters: z.object({ path: z.string() }),
    execute,
  });
  return tools;
}

function deleteCall(id = 'delete-1') {
  return {
    id,
    name: 'delete_file',
    arguments: { path: 'output.txt', force: true },
  };
}

describe('ToolPolicy', () => {
  it('makes one deterministic allow/deny/confirmation decision in the execution layer', () => {
    const policy = new DefaultToolPolicy({
      confirmTools: ['delete_file'],
      denyTools: ['forbidden_tool'],
    });
    const first = deleteCall('first-id');
    const reordered = {
      id: 'another-id',
      name: 'delete_file',
      arguments: { force: true, path: 'output.txt' },
    };
    const fingerprint = fingerprintToolCall(first);

    expect(fingerprintToolCall(reordered)).toBe(fingerprint);
    expect(policy.evaluate({ id: 'read', name: 'read_file', arguments: {} }))
      .toEqual({ action: 'allow' });
    expect(policy.evaluate({ id: 'deny', name: 'forbidden_tool', arguments: {} }))
      .toMatchObject({ action: 'deny' });
    expect(policy.evaluate(first)).toMatchObject({
      action: 'require_confirmation',
      fingerprint,
    });
    expect(policy.evaluate(reordered, { approvedFingerprint: fingerprint }))
      .toEqual({ action: 'allow' });
  });

  it('freezes a dangerous SimpleLoop call and executes it once after process restart', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'policy-simple' }).id;
    const runStore = new RunStore(db);
    const deleteFile = vi.fn(() => ({ deleted: true }));
    const firstAgent = new AgentLoop({
      threadId,
      db,
      tools: deleteTools(deleteFile),
      toolPolicy: new DefaultToolPolicy(),
      modelProvider: new MockProvider([{
        choices: [{ message: {
          content: '',
          tool_calls: [{
            id: 'delete-call',
            function: { name: 'delete_file', arguments: '{"path":"output.txt"}' },
          }],
        } }],
      }]),
      enablePlanning: false,
      subAgents: false,
    });

    const waiting = await firstAgent.chat('Delete output.txt');
    expect(waiting).toMatchObject({
      status: 'waiting_for_input',
      inputRequest: {
        kind: 'tool_approval',
        approval: { toolCall: { name: 'delete_file', arguments: { path: 'output.txt' } } },
      },
    });
    expect(deleteFile).not.toHaveBeenCalled();
    expect(runStore.getById(waiting.runId!)?.status).toBe('waiting_for_input');

    const reopenedAgent = new AgentLoop({
      threadId,
      db,
      tools: deleteTools(deleteFile),
      toolPolicy: new DefaultToolPolicy(),
      modelProvider: new MockProvider([
        { choices: [{ message: { content: 'Deleted output.txt.' } }] },
      ]),
      enablePlanning: false,
      subAgents: false,
    });
    await expect(reopenedAgent.continueRun(waiting.runId!, 'maybe'))
      .rejects.toThrow('explicit approve or reject');
    expect(runStore.getById(waiting.runId!)?.status).toBe('waiting_for_input');
    const completed = await reopenedAgent.continueRun(waiting.runId!, 'approve');

    expect(completed).toMatchObject({ status: 'completed', reply: 'Deleted output.txt.' });
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith({ path: 'output.txt' });
    expect(completed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_received' }),
      expect.objectContaining({ type: 'tool_call' }),
      expect.objectContaining({ type: 'tool_result', status: 'succeeded' }),
    ]));
    db.close();
  });

  it('rejects a frozen call without executing it or calling the model again', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'policy-reject' }).id;
    const deleteFile = vi.fn(() => ({ deleted: true }));
    const firstAgent = new AgentLoop({
      threadId,
      db,
      tools: deleteTools(deleteFile),
      toolPolicy: new DefaultToolPolicy(),
      modelProvider: new MockProvider([{
        choices: [{ message: {
          content: '',
          tool_calls: [{
            id: 'delete-reject',
            function: { name: 'delete_file', arguments: '{"path":"keep.txt"}' },
          }],
        } }],
      }]),
      enablePlanning: false,
      subAgents: false,
    });
    const waiting = await firstAgent.chat('Delete keep.txt');
    const reopenedAgent = new AgentLoop({
      threadId,
      db,
      tools: deleteTools(deleteFile),
      toolPolicy: new DefaultToolPolicy(),
      modelProvider: new MockProvider([]),
      enablePlanning: false,
      subAgents: false,
    });

    const result = await reopenedAgent.continueRun(waiting.runId!, 'reject');

    expect(result).toMatchObject({
      status: 'completed',
      reply: 'Cancelled delete_file; the tool was not executed.',
    });
    expect(deleteFile).not.toHaveBeenCalled();
    db.close();
  });

  it('continues a PlanningLoop after the exact approved step without asking the model to repeat it', async () => {
    const db = createConnection({ path: ':memory:' });
    const threadId = new ThreadStore(db).create({ id: 'policy-planning' }).id;
    const deleteFile = vi.fn(() => ({ deleted: true }));
    const firstAgent = new AgentLoop({
      threadId,
      db,
      tools: deleteTools(deleteFile),
      toolPolicy: new DefaultToolPolicy(),
      modelProvider: new MockProvider([
        { choices: [{ message: { content: JSON.stringify({
          reasoning: 'Delete the requested file.',
          steps: [{ id: '1', description: 'Delete old.txt', toolName: 'delete_file' }],
        }) } }] },
        { choices: [{ message: {
          content: '',
          tool_calls: [{
            id: 'planning-delete',
            function: { name: 'delete_file', arguments: '{"path":"old.txt"}' },
          }],
        } }] },
      ]),
      enablePlanning: true,
      subAgents: false,
    });
    const waiting = await firstAgent.chat('Delete old.txt');
    expect(waiting.status).toBe('waiting_for_input');

    const reopenedAgent = new AgentLoop({
      threadId,
      db,
      tools: deleteTools(deleteFile),
      toolPolicy: new DefaultToolPolicy(),
      modelProvider: new MockProvider([
        { choices: [{ message: { content: 'Deleted old.txt safely.' } }] },
      ]),
      enablePlanning: true,
      subAgents: false,
    });
    const completed = await reopenedAgent.continueRun(waiting.runId!, '确认');

    expect(completed.reply).toBe('Deleted old.txt safely.');
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(reopenedAgent.getReasoningChain().getSteps()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        planStepId: '1',
        observation: expect.objectContaining({ success: true }),
      }),
    ]));
    db.close();
  });
});
