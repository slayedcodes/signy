import { parseComment } from './comment-commands.js';
import type { ResolvedConfig } from './config.js';
import { refusalUnderPolicy } from './policy.js';
import type { CommandError, CommandRule, Deviation, GateComment, GateInput, Signoff } from './types.js';

/**
 * Step 6 of the gate: read every comment's commands, keep the Sign-offs the policy allows
 * whose Deviation still exists (same ID, so same fingerprint), and let the latest one per
 * Deviation decide its status. Everything the gate can't act on becomes a CommandError.
 */
export function applySignoffs(
  input: GateInput,
  deviations: Deviation[],
  config: ResolvedConfig,
): { deviations: Deviation[]; commandErrors: CommandError[] } {
  const commandErrors: CommandError[] = [];
  const latest = new Map<string, OrderedSignoff>();
  const byId = new Map(deviations.map((d) => [d.id, d]));
  let order = 0;

  // Bots can't sign off, and the gate's own summary comment quotes commands; skip them all.
  for (const comment of input.comments.filter((c) => !c.isBot)) {
    const error = (rule: CommandRule, line: string, message: string) =>
      commandErrors.push({ rule, commentUrl: comment.url, author: comment.author, line, message });
    const parsed = parseComment(comment.body);
    parsed.problems.forEach((p) => error(p.rule, p.line, p.message));

    for (const command of parsed.signoffs) {
      const refusal = refusalUnderPolicy(comment, input.pr.author, config);
      if (refusal) {
        error('signoff-not-allowed', command.line, `${comment.author} may not sign off under the Sign-off Policy: ${refusal}`);
        continue;
      }
      if (!byId.has(command.id)) {
        error(
          'signoff-lapsed',
          command.line,
          `${command.id} doesn't match a current Deviation. If it was signed off before, the Deviation has changed since and needs a new Sign-off.`,
        );
        continue;
      }
      const candidate = { ...signoffFrom(comment, command.decision, command.reason), order: order++ };
      const current = latest.get(command.id);
      if (!current || isLater(candidate, current)) latest.set(command.id, candidate);
    }
  }

  return {
    deviations: deviations.map((d) => {
      const decided = latest.get(d.id);
      if (!decided) return d;
      const { order: _order, ...signoff } = decided;
      return { ...d, status: signoff.decision === 'accept' ? 'accepted' : 'rejected', signoff };
    }),
    commandErrors,
  };
}

/** A Sign-off plus its position in the thread, to break ties between equal comment times. */
type OrderedSignoff = Signoff & { order: number };

function signoffFrom(comment: GateComment, decision: Signoff['decision'], reason: string): Signoff {
  return { decision, reason, by: comment.author, at: comment.createdAt, url: comment.url };
}

/** Later by comment time; for equal times, the one that appears later in the thread. */
function isLater(a: OrderedSignoff, b: OrderedSignoff): boolean {
  const [ta, tb] = [Date.parse(a.at), Date.parse(b.at)];
  return ta !== tb ? ta > tb : a.order > b.order;
}
