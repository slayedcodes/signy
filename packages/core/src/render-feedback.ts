import type { Deviation, GateResult } from './types.js';

const KIND = { 'unplanned-change': 'Unplanned Change', 'unmet-clause': 'Unmet Clause' } as const;

/**
 * The gate's result as instructions for the Producing Agent (`contract feedback`): what was
 * rejected, what is still unsigned, and which rules failed. It never suggests editing the
 * Change Contract, because a change of scope needs a new Contract Version and approval.
 */
export function renderFeedback(result: GateResult, where: { pr: string; base: string }): string {
  if (!result.applicable) return `The Change Contract gate doesn't apply to ${where.pr}.\n`;
  if (result.status === 'pass') return `The Change Contract gate passes on ${where.pr}. Nothing to rework.\n`;
  if (result.deviations.length === 0 && result.failures.every((f) => f.rule === 'approval-missing')) {
    return `The Change Contract on ${where.pr} is waiting for its Contract Approval. Push no code until the Approval Commit is on the branch; ask your user to approve it.\n`;
  }

  const lines = [
    `The Change Contract gate fails on ${where.pr}. Rework the change until it passes. Keep the Change Contract as approved: a change of scope needs a new Contract Version and a fresh Contract Approval, so ask your user instead.`,
  ];
  const section = (heading: string, items: string[]) => {
    if (items.length > 0) lines.push('', `## ${heading}`, '', ...items);
  };
  section(
    'Failures',
    result.failures.map((f) => `- ${f.rule}: ${f.message}`),
  );
  section(
    'Rejected Deviations: rework these',
    result.deviations
      .filter((d) => d.status === 'rejected')
      .flatMap((d) => [item(d), `  ${d.signoff!.by} rejected it: "${d.signoff!.reason}"`]),
  );
  section(
    'Unsigned Deviations: remove these, or explain them in the PR description so a reviewer can sign them off',
    result.deviations.filter((d) => d.status === 'unsigned').map(item),
  );
  lines.push('', `Then run \`contract check --base ${where.base}\` and push.`, '');
  return lines.join('\n');
}

const item = (d: Deviation) => `- ${d.id} (${KIND[d.kind]}, ${d.check}) ${d.target}: ${d.detail}`;
