import type { GateInput, GateResult } from './types.js';

/** The machine-readable record of one gate run, for the pilot metrics (PLAN.md §5.7). */
export interface RunSummary {
  schemaVersion: 1;
  generatedAt: string;
  pr: { id?: string; author: string; branch: string; base: string; head: string };
  status: GateResult['status'];
  applicable: boolean;
  failures: Record<string, number>;
  deviations: { total: number; byKind: Record<string, number>; byCheck: Record<string, number> };
  signoffs: { accepted: number; rejected: number; unsigned: number };
  /** Seconds from the Contract Commit to the approval comment, when both times are known. */
  approvalLatencySeconds: number | null;
}

export function buildRunSummary(
  input: GateInput,
  result: GateResult,
  options: { generatedAt: string; prId?: string },
): RunSummary {
  const count = (keys: string[]) =>
    keys.reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {});
  const { author, branch, base, head } = input.pr;
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    pr: { ...(options.prId ? { id: options.prId } : {}), author, branch, base, head },
    status: result.status,
    applicable: result.applicable,
    failures: count(result.failures.map((f) => f.rule)),
    deviations: {
      total: result.deviations.length,
      byKind: count(result.deviations.map((d) => d.kind)),
      byCheck: count(result.deviations.map((d) => d.check)),
    },
    signoffs: { accepted: 0, rejected: 0, unsigned: 0, ...count(result.deviations.map((d) => d.status)) },
    approvalLatencySeconds: approvalLatency(input, result),
  };
}

function approvalLatency(input: GateInput, result: GateResult): number | null {
  const contractCommittedAt = input.commits[0]?.committedAt;
  const approvedAt = result.approval?.approvedAt;
  if (!contractCommittedAt || !approvedAt) return null;
  return Math.round((Date.parse(approvedAt) - Date.parse(contractCommittedAt)) / 1000);
}
