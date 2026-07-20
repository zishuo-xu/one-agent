import { describe, expect, it } from 'vitest';
import {
  buildSubAgentEvidencePacket,
  formatSubAgentEvidencePacket,
} from '../../src/agents/SubAgentContract.js';

describe('SubAgent evidence contract', () => {
  it('pairs successful tool observations with their call provenance', () => {
    const packet = buildSubAgentEvidencePacket(
      { task: 'inspect config', expectedEvidence: ['the configured port'] },
      'The port is 3000.',
      [
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'read_file', arguments: { path: 'config.json' } },
        },
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          toolResult: { success: true, data: { port: 3000 } },
        },
      ],
    );

    expect(packet).toEqual({
      conclusion: 'The port is 3000.',
      evidence: [{
        toolCallId: 'call-1',
        toolName: 'read_file',
        source: 'config.json',
        observation: '{"port":3000}',
      }],
      uncertainty: [],
      unresolvedQuestions: [],
    });
    expect(formatSubAgentEvidencePacket(packet)).toContain('"toolCallId": "call-1"');
  });

  it('makes model-only conclusions and missing requested evidence explicit', () => {
    const packet = buildSubAgentEvidencePacket(
      { task: 'research', expectedEvidence: ['an authoritative source'] },
      'Likely true.',
      [],
    );

    expect(packet.evidence).toEqual([]);
    expect(packet.uncertainty).toContain(
      'No successful tool observation was collected; the conclusion is model-only.',
    );
    expect(packet.unresolvedQuestions).toEqual([
      'Evidence not collected: an authoritative source',
    ]);
  });

  it('records failed observations as uncertainty instead of evidence', () => {
    const packet = buildSubAgentEvidencePacket(
      { task: 'read missing file' },
      'No result.',
      [
        {
          type: 'tool_call',
          toolCall: { id: 'call-2', name: 'read_file', arguments: { path: 'missing.txt' } },
        },
        {
          type: 'tool_result',
          toolCallId: 'call-2',
          toolResult: { success: false, error: 'not found' },
        },
      ],
    );

    expect(packet.evidence).toEqual([]);
    expect(packet.uncertainty).toContain('read_file failed: not found');
  });

  it('redacts credential-shaped fields before evidence reaches the parent', () => {
    const packet = buildSubAgentEvidencePacket(
      { task: 'inspect config' },
      'Config inspected.',
      [
        {
          type: 'tool_call',
          toolCall: { id: 'call-secret', name: 'read_file', arguments: { path: 'config.json' } },
        },
        {
          type: 'tool_result',
          toolCallId: 'call-secret',
          toolResult: { success: true, data: { apiKey: 'sk-private', model: 'safe-model' } },
        },
      ],
    );

    expect(packet.evidence[0].observation).toContain('"apiKey":"[REDACTED]"');
    expect(packet.evidence[0].observation).not.toContain('sk-private');
    expect(packet.evidence[0].observation).toContain('safe-model');
  });
});
