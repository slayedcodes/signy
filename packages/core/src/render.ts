import type { Deviation, GateResult } from './types.js';

const KIND = { 'unplanned-change': 'Unplanned Change', 'unmet-clause': 'Unmet Clause' } as const;

/**
 * The human-readable gate summary (PLAN.md §5.7), as Markdown: the host adapter posts it as
 * the PR comment, and `contract check` prints it. Every unsigned or rejected Deviation shows
 * the exact command to sign it off.
 */
export function renderSummary(result: GateResult): string {
  const verdict = !result.applicable ? '✅ not applicable' : result.status === 'pass' ? '✅ pass' : '❌ fail';
  const lines = [`## Change Contract gate: ${verdict}`, '', ...result.notes.map((n) => `- ${n}`)];

  if (result.failures.length > 0) {
    lines.push('', '### Failures', '', ...result.failures.map((f) => `- **${f.rule}**: ${f.message}`));
  }
  if (result.deviations.length > 0) {
    lines.push(
      '',
      '### Deviations',
      '',
      '| ID | Kind | Target | Status | Sign off |',
      '| --- | --- | --- | --- | --- |',
      ...result.deviations.map(
        (d) =>
          `| \`${d.id}\` | ${KIND[d.kind]} | \`${cell(d.target)}\` | ${cell(status(d))} | ${d.status === 'accepted' ? '' : `\`/signoff ${d.id} accept "<reason>"\``} |`,
      ),
      '',
      ...result.deviations.map((d) => `- \`${d.id}\`: ${d.detail}`),
    );
  }
  if (result.commandErrors.length > 0) {
    lines.push(
      '',
      "### Commands the gate couldn't act on",
      '',
      ...result.commandErrors.map((e) => `- ${e.author}, \`${e.line}\` (${e.commentUrl}): ${e.message}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function status(d: Deviation): string {
  if (!d.signoff) return d.status;
  return `${d.status} by ${d.signoff.by}${d.signoff.reason ? `: ${d.signoff.reason}` : ''}`;
}

/** Keeps free text from breaking a Markdown table row. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
