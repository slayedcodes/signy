import type { CommandRule, SignoffDecision } from './types.js';

export interface ApproveCommand {
  /** The Contract Version the command names; when omitted it means the current contract's hash. */
  hash?: string;
}

export interface SignoffCommand {
  /** The Deviation's display ID, normalized to `D` + lowercase hex. */
  id: string;
  decision: SignoffDecision;
  reason: string;
  line: string;
}

export interface CommandProblem {
  rule: CommandRule;
  line: string;
  message: string;
}

export interface ParsedComment {
  approvals: ApproveCommand[];
  signoffs: SignoffCommand[];
  problems: CommandProblem[];
}

const SYNTAX =
  'The gate understands /contract approve [sha256:<hash>], /signoff <id> accept "<reason>" and /signoff <id> reject "<reason>".';
const APPROVE = /^\/contract\s+approve(?:\s+(sha256:[0-9a-f]{64}))?$/i;
const SIGNOFF = /^\/signoff\s+(D[0-9a-fA-F]+)\s+(accept|reject)(?:\s+["“](.*)["”])?$/i;

/**
 * Reads the commands in one comment (PLAN.md §6): one per line, several per comment allowed.
 * Lines inside fenced code blocks are quoted text, not commands. A line that starts like a
 * command but can't be read is a problem to reply to, never silently ignored.
 */
export function parseComment(body: string): ParsedComment {
  const parsed: ParsedComment = { approvals: [], signoffs: [], problems: [] };
  let inFence = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) inFence = !inFence;
    const lower = line.toLowerCase();
    if (inFence || !(lower.startsWith('/contract') || lower.startsWith('/signoff'))) continue;

    const approve = APPROVE.exec(line);
    if (approve) {
      parsed.approvals.push(approve[1] ? { hash: approve[1].toLowerCase() } : {});
      continue;
    }
    if (/^\/contract\s+approve\b/i.test(line)) {
      parsed.problems.push({ rule: 'command-unreadable', line, message: `Couldn't read this approval. ${SYNTAX}` });
      continue;
    }
    if (lower.startsWith('/contract')) {
      parsed.problems.push({ rule: 'command-unknown', line, message: `Unknown command. ${SYNTAX}` });
      continue;
    }
    const signoff = SIGNOFF.exec(line);
    if (!signoff) {
      parsed.problems.push({ rule: 'command-unreadable', line, message: `Couldn't read this Sign-off. ${SYNTAX}` });
      continue;
    }
    const decision = signoff[2]!.toLowerCase() as SignoffDecision;
    const reason = (signoff[3] ?? '').trim();
    if (decision === 'accept' && reason === '') {
      parsed.problems.push({ rule: 'signoff-needs-reason', line, message: 'An accept needs a reason: /signoff <id> accept "<reason>".' });
      continue;
    }
    parsed.signoffs.push({ id: `D${signoff[1]!.slice(1).toLowerCase()}`, decision, reason, line });
  }
  return parsed;
}
