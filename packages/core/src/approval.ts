import { parseComment } from './comment-commands.js';
import type { ResolvedConfig } from './config.js';
import type { LocatedContract } from './contract-structure.js';
import type { ContractApproval, GateCommit, GateComment, GateFailure, GateInput } from './types.js';
import { refusalUnderPolicy } from './policy.js';
import { listAnd, sameLogin, shortSha } from './text.js';
import { readTrailers } from './trailers.js';

export interface ApprovalCheck {
  note?: string;
  approval?: ContractApproval;
  failures: GateFailure[];
}

const APPROVAL_TRAILERS = ['Contract-Hash', 'Approved-By', 'Approval-Comment'] as const;

/** Step 3 of the gate: a genuine Approval Commit precedes every code commit. */
export function checkApproval(input: GateInput, contract: LocatedContract, config: ResolvedConfig): ApprovalCheck {
  const afterContractCommit = commitsAfter(contract, input.commits);
  const failures: GateFailure[] = [];
  let approval: { index: number; approver: string; comment?: GateComment } | undefined;

  afterContractCommit.forEach((commit, index) => {
    if (!claimsToBeApproval(commit, input)) return;
    const verdict = verifyApprovalCommit(commit, input, contract, config);
    failures.push(...verdict.failures);
    if (verdict.approver !== undefined && !approval) approval = { index, approver: verdict.approver, comment: verdict.comment };
  });

  if (!approval) {
    failures.push({
      rule: 'approval-missing',
      message: `No valid Approval Commit for Change Contract ${contract.path} (${contract.hash}). A reviewer approves it by commenting \`/contract approve\` on the PR.`,
    });
    return { failures };
  }

  const approvalCommit = afterContractCommit[approval.index]!;
  // Order is ancestry, not list position: code on a side branch merged in later never built on the approval.
  const builtOnApproval = descendantsOf(approvalCommit.sha, input.commits);
  const earlyCode = afterContractCommit.find((commit) => commit.files.length > 0 && !builtOnApproval.has(commit.sha));
  if (earlyCode) {
    failures.push({
      rule: 'approval-after-code',
      message: `Commit ${shortSha(earlyCode.sha)} contains code but doesn't build on the Approval Commit ${shortSha(approvalCommit.sha)}. Code commits are allowed only after the Contract Approval; drop or rebase them, then re-approve.`,
      commit: earlyCode.sha,
    });
  }
  return {
    note: `Change Contract ${contract.path} approved by ${approval.approver} in Approval Commit ${shortSha(approvalCommit.sha)}.`,
    approval: {
      by: approval.approver,
      commit: approvalCommit.sha,
      ...(approval.comment ? { commentUrl: approval.comment.url, approvedAt: approval.comment.createdAt } : {}),
    },
    failures,
  };
}

/** The PR's commits after the Contract Commit, in order. */
export function commitsAfter(contract: LocatedContract, commits: GateCommit[]): GateCommit[] {
  return commits.slice(commits.indexOf(contract.commit) + 1);
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
): { failures: GateFailure[]; approver?: string; comment?: GateComment } {
  const failures: GateFailure[] = [];
  const fail = (rule: string, message: string) =>
    failures.push({ rule, message: `Commit ${shortSha(commit.sha)} ${message}`, commit: commit.sha });

  if (!isAuthoredByBot(commit, input)) {
    fail(
      'approval-not-bot',
      `looks like an Approval Commit but was authored by ${commit.author.name} <${commit.author.email}>, not the gate bot ${input.bot.name} <${input.bot.email}>.`,
    );
  }
  if (input.hostVerifiesSignatures && !commit.signatureVerified) {
    fail(
      'approval-not-verified',
      "is an Approval Commit, but the code host hasn't verified its signature. Only the gate pushes Approval Commits, and the host signs them.",
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

  // Locally there are no comments: the commit-level checks are all `contract check` can do.
  if (input.local) return failures.length === 0 ? { failures, approver: approvedBy } : { failures };

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
  const approves = parseComment(comment.body).approvals.some((cmd) => (cmd.hash ?? contract.hash) === approvedHash);
  if (!approves) {
    fail(
      'approval-comment-command',
      `cites Approval-Comment ${commentUrl}, which has no \`/contract approve\` command for ${approvedHash}.`,
    );
  }
  return failures.length === 0 ? { failures, approver: comment.author, comment } : { failures };
}

/** The commit itself plus every listed commit that has it as an ancestor. Commits come parents-first. */
function descendantsOf(sha: string, commits: GateCommit[]): Set<string> {
  const descendants = new Set([sha]);
  for (const commit of commits) {
    if (commit.parents.some((parent) => descendants.has(parent))) descendants.add(commit.sha);
  }
  return descendants;
}

function isAuthoredByBot(commit: GateCommit, input: GateInput): boolean {
  return commit.author.name === input.bot.name && commit.author.email === input.bot.email;
}
