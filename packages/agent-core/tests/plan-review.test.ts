import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../src/agents/AgentLoop.js';
import type { PlanningRunCheckpoint } from '../src/agents/checkpoint.js';
import { createConnection } from '../src/db/connection.js';
import { RunStore } from '../src/db/runStore.js';
import { ThreadStore } from '../src/db/threadStore.js';
import { TraceEventStore } from '../src/db/traceEventStore.js';
import { MockProvider } from '../src/model/MockProvider.js';
import { parsePlanReviewAnswer } from '../src/planning/planReview.js';
import { ToolRegistry } from '../src/tools/registry.js';

function planResponse(description: string) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          reasoning: 'One safe step',
          steps: [{
            id: '1',
            description,
            toolName: 'echo',
            expectedOutcome: 'The text is echoed',
          }],
        }),
      },
    }],
  };
}

function toolCallResponse(message: string) {
  return {
    choices: [{
      message: {
        content: 'Calling echo.',
        tool_calls: [{
          id: 'echo-call',
          type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ message }) },
        }],
      },
    }],
  };
}

function textResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('planning review and continuation', () => {
  function setup() {
    const db = createConnection({ path: ':memory:' });
    const thread = new ThreadStore(db).create({ title: 'plan review' });
    const runs = new RunStore(db);
    const traces = new TraceEventStore(db);
    const execute = vi.fn((args: unknown) => args);
    const tools = new ToolRegistry();
    tools.register({
      name: 'echo',
      description: 'Echo text',
      parameters: z.object({ message: z.string() }),
      execute,
    });
    const agent = (responses: unknown[]) => new AgentLoop({
      db,
      threadId: thread.id,
      tools,
      modelProvider: new MockProvider(responses),
      enablePlanning: true,
      requirePlanApproval: true,
      subAgents: false,
    });
    return { db, thread, runs, traces, execute, agent };
  }

  it('persists the frozen plan and executes it only after approval', async () => {
    const fixture = setup();
    const waiting = await fixture.agent([planResponse('Echo hello')]).chat('Echo hello');

    expect(waiting.status).toBe('waiting_for_input');
    expect(waiting.inputRequest).toMatchObject({
      kind: 'plan_approval',
      options: ['approve', 'reject'],
      planReview: { revision: 0, maxRevisions: 1 },
    });
    expect(waiting.reply).toContain('1. Echo hello [echo]');
    expect(fixture.execute).not.toHaveBeenCalled();

    const checkpoint = fixture.traces.getLatestRecoveryPoint(waiting.runId!);
    expect(checkpoint).toMatchObject({ loopMode: 'planning', planApproved: false });

    const completed = await fixture.agent([
      toolCallResponse('hello'),
      textResponse('Done: hello'),
    ]).continueRun(waiting.runId!, 'approve');

    expect(completed).toMatchObject({ status: 'completed', reply: 'Done: hello' });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.traces.getByThread(fixture.thread.id).some((event) =>
      event.eventType === 'plan_review' &&
      (event.eventData as { phase?: string }).phase === 'approved'
    )).toBe(true);
    fixture.db.close();
  });

  it('rejects a plan without invoking the model or any tool again', async () => {
    const fixture = setup();
    const waiting = await fixture.agent([planResponse('Echo nothing')]).chat('Echo nothing');

    const completed = await fixture.agent([]).continueRun(waiting.runId!, 'reject');

    expect(completed).toMatchObject({
      status: 'completed',
      reply: 'Plan rejected; no steps were executed.',
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.traces.getByThread(fixture.thread.id).some((event) =>
      event.eventType === 'plan_review' &&
      (event.eventData as { phase?: string }).phase === 'rejected'
    )).toBe(true);
    fixture.db.close();
  });

  it('allows one feedback-driven revision, then requires approve or reject', async () => {
    const fixture = setup();
    const firstReview = await fixture.agent([planResponse('Echo the original text')])
      .chat('Echo some text');

    const revisingAgent = fixture.agent([planResponse('Echo the revised text')]);
    const secondReview = await revisingAgent.continueRun(
      firstReview.runId!,
      'Change the text to revised',
    );

    expect(secondReview.status).toBe('waiting_for_input');
    expect(secondReview.reply).toContain('1. Echo the revised text [echo]');
    expect(secondReview.inputRequest?.planReview).toEqual({ revision: 1, maxRevisions: 1 });
    const checkpoint = fixture.traces.getLatestRecoveryPoint(secondReview.runId!) as PlanningRunCheckpoint;
    expect(checkpoint.planRevisionCount).toBe(1);
    expect(checkpoint.recoveryCount).toBe(0);
    expect(checkpoint.planApproved).toBe(false);
    expect(checkpoint.plan.steps[0]?.description).toBe('Echo the revised text');
    expect(revisingAgent.getHistory().some((message) =>
      message.role === 'user' && message.content === 'Change the text to revised'
    )).toBe(false);
    expect(fixture.execute).not.toHaveBeenCalled();

    await expect(fixture.agent([]).continueRun(secondReview.runId!, 'Change it again'))
      .rejects.toThrow('already been revised once');
    expect(fixture.runs.getById(secondReview.runId!)?.status).toBe('waiting_for_input');

    const completed = await fixture.agent([
      toolCallResponse('revised'),
      textResponse('Done: revised'),
    ]).continueRun(secondReview.runId!, '确认');
    expect(completed).toMatchObject({ status: 'completed', reply: 'Done: revised' });
    expect(fixture.execute).toHaveBeenCalledOnce();
    fixture.db.close();
  });

  it('recognizes concise Chinese and English control answers', () => {
    expect(parsePlanReviewAnswer('确认')).toEqual({ decision: 'approve' });
    expect(parsePlanReviewAnswer('reject')).toEqual({ decision: 'reject' });
    expect(parsePlanReviewAnswer('先读取配置再执行')).toEqual({
      decision: 'revise',
      feedback: '先读取配置再执行',
    });
  });
});
