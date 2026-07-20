import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceCompletionVerifier } from '../../src/verification/EvidenceCompletionVerifier.js';
import { Sandbox } from '@one-agent/agent-core';
import type { AgentLoopEvent } from '@one-agent/agent-core';

describe('EvidenceCompletionVerifier', () => {
  let root: string;
  let sandbox: Sandbox;
  let verifier: EvidenceCompletionVerifier;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completion-verifier-')));
    sandbox = new Sandbox(root);
    verifier = new EvidenceCompletionVerifier({ sandbox });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('marks an unsupported text-only claim as unverified', async () => {
    const outcome = await verifier.verify({
      request: 'What is the answer?',
      reply: 'The answer is 42.',
      events: [{ type: 'message', content: 'The answer is 42.' }],
    });

    expect(outcome.status).toBe('unverified');
    expect(outcome.reason).toContain('no independent evidence');
  });

  it('marks successful tool-backed execution as verified', async () => {
    const events: AgentLoopEvent[] = [
      { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: { path: 'input.txt' } } },
      { type: 'tool_result', toolResult: { success: true, data: { content: 'hello' } } },
      { type: 'message', content: 'The file says hello.' },
    ];

    const outcome = await verifier.verify({ request: 'Read input.txt', reply: 'The file says hello.', events });

    expect(outcome.status).toBe('verified');
    expect(outcome.evidence).toContainEqual(
      expect.objectContaining({ kind: 'tool', toolName: 'read_file', success: true }),
    );
  });

  it('does not trust a claimed deliverable when the file is missing', async () => {
    const outcome = await verifier.verify({
      request: '请生成 weekly.md 给我',
      reply: 'weekly.md 已生成。',
      events: [{ type: 'message', content: 'weekly.md 已生成。' }],
    });

    expect(outcome.status).toBe('unverified');
    expect(outcome.reason).toContain('weekly.md');
    expect(outcome.evidence).toContainEqual(
      expect.objectContaining({ kind: 'artifact', path: 'weekly.md', success: false }),
    );
  });

  it('verifies an explicitly requested artifact against the workspace', async () => {
    fs.writeFileSync(path.join(root, 'weekly.md'), '# Weekly\n', 'utf-8');

    const outcome = await verifier.verify({
      request: '请生成 weekly.md 给我',
      reply: 'weekly.md 已生成。',
      events: [
        {
          type: 'tool_call',
          toolCall: { id: 'write-weekly', name: 'write_file', arguments: { path: 'weekly.md' } },
        },
        {
          type: 'tool_result',
          toolCallId: 'write-weekly',
          toolResult: { success: true },
        },
        { type: 'message', content: 'weekly.md 已生成。' },
      ],
    });

    expect(outcome.status).toBe('verified');
    expect(outcome.evidence).toContainEqual(
      expect.objectContaining({ kind: 'artifact', path: 'weekly.md', success: true }),
    );
  });

  it('returns partial when some execution evidence succeeded and some failed', async () => {
    const events: AgentLoopEvent[] = [
      { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } } },
      { type: 'tool_result', toolResult: { success: true } },
      { type: 'tool_call', toolCall: { id: 'c2', name: 'write_file', arguments: { path: 'b.txt' } } },
      { type: 'tool_result', toolResult: { success: false, error: 'disk full' } },
      { type: 'message', content: 'Only part of the task was completed.' },
    ];

    const outcome = await verifier.verify({ request: 'Process the files', reply: 'Partial result', events });

    expect(outcome.status).toBe('partial');
  });

  it('allows a later successful tool execution to recover an earlier failure', async () => {
    const events: AgentLoopEvent[] = [
      { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: { path: 'missing.txt' } } },
      { type: 'tool_result', toolResult: { success: false, error: 'not found' } },
      { type: 'tool_call', toolCall: { id: 'c2', name: 'read_file', arguments: { path: 'fallback.txt' } } },
      { type: 'tool_result', toolResult: { success: true, data: { content: 'recovered' } } },
      { type: 'message', content: 'Recovered from the fallback file.' },
    ];

    const outcome = await verifier.verify({ request: 'Read the available report', reply: 'Recovered.', events });

    expect(outcome.status).toBe('verified');
    expect(outcome.evidence).toContainEqual(
      expect.objectContaining({ kind: 'tool', success: false }),
    );
  });

  it('treats incomplete plan steps as partial despite successful tools', async () => {
    const events: AgentLoopEvent[] = [
      {
        type: 'plan',
        plan: {
          reasoning: 'test',
          steps: [
            { id: '1', description: 'Read input', status: 'completed' },
            { id: '2', description: 'Write output', status: 'failed' },
          ],
        },
      },
      { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } } },
      { type: 'tool_result', toolResult: { success: true } },
      { type: 'message', content: 'Stopped early.' },
    ];

    const outcome = await verifier.verify({ request: 'Process input', reply: 'Stopped early.', events });

    expect(outcome.status).toBe('partial');
  });

  it('correlates results by tool-call id instead of assigning a later result to an unexecuted write', async () => {
    const events: AgentLoopEvent[] = [
      {
        type: 'tool_call',
        toolCall: { id: 'write-config', name: 'write_file', arguments: { path: 'config.yaml' } },
      },
      {
        type: 'tool_call',
        toolCall: { id: 'search-loader', name: 'search_files', arguments: { pattern: '*.py' } },
      },
      {
        type: 'tool_result',
        toolCallId: 'search-loader',
        toolResult: { success: true, data: { matches: ['loader.py'] } },
      },
    ];

    const outcome = await verifier.verify({
      request: '把配置迁移到 config.yaml',
      reply: '目前只完成了引用搜索。',
      events,
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.evidence).toContainEqual(
      expect.objectContaining({ kind: 'tool', toolName: 'write_file', success: false }),
    );
    expect(outcome.evidence).toContainEqual(
      expect.objectContaining({ kind: 'artifact', path: 'config.yaml', success: false }),
    );
  });

  it('does not verify a mutation request from read-only evidence', async () => {
    const events: AgentLoopEvent[] = [
      {
        type: 'tool_call',
        toolCall: { id: 'read-build', name: 'read_file', arguments: { path: 'build.sh' } },
      },
      {
        type: 'tool_result',
        toolCallId: 'read-build',
        toolResult: { success: true, data: { content: 'broken' } },
      },
    ];

    const outcome = await verifier.verify({
      request: '请修复 build.sh',
      reply: '已分析出问题。',
      events,
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.reason).toContain('no successful mutation');
  });

  it('downgrades an explicit self-report of incomplete work', async () => {
    const events: AgentLoopEvent[] = [
      {
        type: 'tool_call',
        toolCall: { id: 'run-build', name: 'run_command', arguments: { command: 'sh build.sh' } },
      },
      {
        type: 'tool_result',
        toolCallId: 'run-build',
        toolResult: { success: true, data: { exitCode: 0, stdout: 'BUILD_OK' } },
      },
    ];

    const outcome = await verifier.verify({
      request: '修复构建并跑到成功',
      reply: '构建仍然失败，需要继续修复。',
      events,
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.reason).toContain('explicitly reported');
  });

  it('checks artifact content from a caller-supplied completion contract', async () => {
    fs.writeFileSync(path.join(root, 'weekly.md'), '# 完成\n- 登录页开发\n', 'utf-8');
    const contractVerifier = new EvidenceCompletionVerifier({
      sandbox,
      requirements: [
        {
          kind: 'artifact',
          path: 'weekly.md',
          containsAll: ['登录页开发', '修复NPE'],
        },
      ],
    });

    const outcome = await contractVerifier.verify({
      request: '汇总周报到 weekly.md',
      reply: '周报已生成。',
      events: [
        {
          type: 'tool_call',
          toolCall: { id: 'write-weekly', name: 'write_file', arguments: { path: 'weekly.md' } },
        },
        {
          type: 'tool_result',
          toolCallId: 'write-weekly',
          toolResult: { success: true },
        },
      ],
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.reason).toContain('Completion contract');
    expect(outcome.evidence).toContainEqual(
      expect.objectContaining({ kind: 'artifact', path: 'weekly.md', success: false }),
    );
  });

  it('verifies a satisfied artifact and response completion contract', async () => {
    fs.writeFileSync(path.join(root, 'dist.txt'), 'BUILD_OK\n', 'utf-8');
    const contractVerifier = new EvidenceCompletionVerifier({
      sandbox,
      requirements: [
        { kind: 'artifact', path: 'dist.txt', containsAll: ['BUILD_OK'] },
        { kind: 'response', containsAny: ['成功', 'succeeded'] },
      ],
    });

    const outcome = await contractVerifier.verify({
      request: '修复构建并生成 dist.txt',
      reply: '构建成功。',
      events: [
        {
          type: 'tool_call',
          toolCall: { id: 'write-dist', name: 'write_file', arguments: { path: 'dist.txt' } },
        },
        {
          type: 'tool_result',
          toolCallId: 'write-dist',
          toolResult: { success: true },
        },
      ],
    });

    expect(outcome.status).toBe('verified');
  });
});
