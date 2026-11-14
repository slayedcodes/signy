import { parseApproveCommands } from './comment-commands.js';
import type { ResolvedConfig } from './config.js';
import type { LocatedContract } from './contract-structure.js';
import type { GateCommit, GateComment, GateFailure, GateInput } from './gate.js';
import { refusalUnderPolicy } from './policy.js';
import { listAnd, sameLogin, shortSha } from './text.js';
import { readTrailers } from './trailers.js';

export interface ApprovalCheck {
  note?: string;
  failures: GateFailure[];
}

const APPROVAL_TRAILERS = ['Contract-Hash', 'Approved-By', 'Approval-Comment'] as const;

/** Step 3 of the gate: a genuine Approval Commit precedes every code commit. */
export function checkApproval(input: GateInput, contract: LocatedContract, config: ResolvedConfig): ApprovalCheck {
  const afterContractCommit = input.commits.slice(input.commits.indexOf(contract.commit) + 1);
  const failures: GateFailure[] = [];
  let approval: { index: number; comment: GateComment } | undefined;

  afterContractCommit.forEach((commit, index) => {
    if (!claimsToBeApproval(commit, input)) return;
    const verdict = verifyApprovalCommit(commit, input, contract, config);
    failures.push(...verdict.failures);
    if (verdict.comment && !approval) approval = { index, comment: verdict.comment };
  });

  if (!approval) {
    failures.push({
      rule: 'approval-missing',
      message: `No valid Approval Commit for Change Contract ${contract.path} (${contract.hash}). A reviewer approves it by commenting \`/contract approve\` on the PR.`,
    });
    return { failures };
  }

  const approvalCommit = afterContractCommit[approval.index]!;
  const earlyCode = afterContractCommit.slice(0, approval.index).find((commit) => commit.files.length > 0);
  if (earlyCode) {
    failures.push({
      rule: 'approval-after-code',
      message: `Commit ${shortSha(earlyCode.sha)} contains code but comes before the Approval Commit ${shortSha(approvalCommit.sha)}. Code commits are allowed only after the Contract Approval; drop or rebase them, then re-approve.`,
      commit: earlyCode.sha,
    });
  }
  return {
    note: `Change Contract ${contract.path} approved by ${approval.comment.author} in Approval Commit ${shortSha(approvalCommit.sha)}.`,
    failures,
  };
}

/**
 * A commit claims to be an Approval Commit if the gate bot authored it or it carries
 * a Contract-Hash trailer. Other trailers (Approved-By is a common team convention) don't count.
 */
function claimsToBeApproval(commit: GateCommit, input: GateInput): boolean {
  return isAuthoredByBot(commit, input) || readTrailers(commit.message).has('contract-hash');
}

/** Checks one claimed Approval Commit; `comment` is set only when the approval is genuine. */
function verifyApprovalCommit(
  commit: GateCommit,
  input: GateInput,
  contract: LocatedContract,
  config: ResolvedConfig,
): { failures: GateFailure[]; comment?: GateComment } {
  const failures: GateFailure[] = [];
  const fail = (rule: string, message: string) =>
    failures.push({ rule, message: `Commit ${shortSha(commit.sha)} ${message}`, commit: commit.sha });

  if (!isAuthoredByBot(commit, input)) {
    fail(
      'approval-not-bot',
      `looks like an Approval Commit but was authored by ${commit.author.name} <${commit.author.email}>, not the gate bot ${input.bot.name} <${input.bot.email}>.`,
    );
  }
  if (commit.files.length > 0) {
    fail(
      'approval-not-empty',
      `is an Approval Commit but changes files (${commit.files.map((f) => f.path).join(', ')}); it must be empty.`,
    );
  }

  const trailers = readTrailers(commit.message);
  const [approvedHash, approvedBy, commentUrl] = APPROVAL_TRAILERS.map((t) => trailers.get(t.toLowerCase())?.[0]);
  const missing = APPROVAL_TRAILERS.filter((t) => !trailers.has(t.toLowerCase()));
  if (approvedHash === undefined || approvedBy === undefined || commentUrl === undefined) {
    const noun = missing.length === 1 ? 'trailer' : 'trailers';
    fail('approval-trailers', `is an Approval Commit but lacks the ${listAnd(missing)} ${noun}.`);
    return { failures };
  }

  if (approvedHash !== contract.hash) {
    fail(
      'approval-hash-mismatch',
      `approves Contract-Hash ${approvedHash}, but the Change Contract's hash is ${contract.hash}. A different Contract Version needs a fresh Contract Approval.`,
    );
  }

  const comment = input.comments.find((c) => c.url === commentUrl);
  if (!comment) {
    fail('approval-comment-missing', `cites Approval-Comment ${commentUrl}, but the PR has no such comment.`);
    return { failures };
  }
  if (!sameLogin(comment.author, approvedBy)) {
    fail(
      'approval-comment-author',
      `says Approved-By: ${approvedBy}, but Approval-Comment ${commentUrl} was written by ${comment.author}.`,
    );
  }
  const refusal = refusalUnderPolicy(comment, input.pr.author, config);
  if (refusal) {
    fail(
      'approver-not-allowed',
      `records a Contract Approval by ${comment.author}, whom the Sign-off Policy doesn't allow: ${refusal}`,
    );
  }
  const approves = parseApproveCommands(comment.body).some((cmd) => (cmd.hash ?? contract.hash) === approvedHash);
  if (!approves) {
    fail(
      'approval-comment-command',
      `cites Approval-Comment ${commentUrl}, which has no \`/contract approve\` command for ${approvedHash}.`,
    );
  }
  return failures.length === 0 ? { failures, comment } : { failures };
}

function isAuthoredByBot(commit: GateCommit, input: GateInput): boolean {
  return commit.author.name === input.bot.name && commit.author.email === input.bot.email;
}
