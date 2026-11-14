import { describe, expect, it } from 'vitest';
import { buildRunSummary, type GateInput, type GateResult } from '../src/index.js';

const input = {
  pr: { author: 'agent-operator', labels: [], branch: 'claude/say-hi', base: 'b'.repeat(40), head: 'h'.repeat(40) },
  commits: [{ sha: 'c'.repeat(40), author: { name: 'A', email: 'a@x' }, message: 'contract', files: [], committedAt: '2026-11-14T10:00:00Z' }],
  comments: [],
  config: {},
  bot: { name: 'bot', email: 'bot@x' },
} as unknown as GateInput;

const result: GateResult = {
  status: 'fail',
  applicable: true,
  notes: [],
  failures: [{ rule: 'contract-changed-later', message: '…' }],
  deviations: [
    { id: 'D1', fingerprint: '1', kind: 'unplanned-change', check: 'scope', target: 'a.ts', detail: '', status: 'accepted' },
    { id: 'D2', fingerprint: '2', kind: 'unplanned-change', check: 'dependencies', target: 'zod', detail: '', status: 'rejected' },
    { id: 'D3', fingerprint: '3', kind: 'unmet-clause', check: 'dependencies', target: 'p-retry', detail: '', status: 'unsigned' },
  ],
  commandErrors: [],
  approval: { by: 'reviewer', commit: 'a'.repeat(40), commentUrl: 'https://x/1', approvedAt: '2026-11-14T10:45:30Z' },
};

describe('buildRunSummary', () => {
  it('counts Deviations and Sign-off outcomes, and measures approval latency from the Contract Commit', () => {
    expect(buildRunSummary(input, result, { generatedAt: '2026-11-14T12:00:00Z', prId: 'acme/pilot#42' })).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-11-14T12:00:00Z',
      pr: { id: 'acme/pilot#42', author: 'agent-operator', branch: 'claude/say-hi', base: 'b'.repeat(40), head: 'h'.repeat(40) },
      status: 'fail',
      applicable: true,
      failures: { 'contract-changed-later': 1 },
      deviations: { total: 3, byKind: { 'unplanned-change': 2, 'unmet-clause': 1 }, byCheck: { scope: 1, dependencies: 2 } },
      signoffs: { accepted: 1, rejected: 1, unsigned: 1 },
      approvalLatencySeconds: 2730,
    });
  });
});
