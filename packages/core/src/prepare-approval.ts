import { checkApproval, commitsAfter } from './approval.js';
import { parseComment } from './comment-commands.js';
import { resolveConfig } from './config.js';
import { checkContractStructure } from './contract-structure.js';
import { refusalUnderPolicy } from './policy.js';
import { shortSha } from './text.js';
import type { GateComment, GateInput } from './types.js';

/** What the host adapter does with a `/contract approve` comment. */
export type ApprovalDecision =
  /** Push an empty Approval Commit with this message on top of `parent`, as the gate bot. */
  | { action: 'push'; parent: string; message: string }
  /** Nothing to do: the comment has no `/contract approve` command. */
  | { action: 'none'; reason: string }
  /** Nothing to do: the current Contract Version already has a valid Approval Commit. */
  | { action: 'already-approved'; reason: string }
  /** The approval can't be recorded; the adapter replies with the reason. */
  | { action: 'refuse'; reason: string };

/**
 * Decides whether a comment's `/contract approve` may become an Approval Commit on the PR head.
 * The gate re-checks everything on its next run; this only keeps the bot from recording
 * approvals the gate would reject.
 */
export async function prepareApproval(input: GateInput, comment: GateComment): Promise<ApprovalDecision> {
  const commands = parseComment(comment.body).approvals;
  if (commands.length === 0) return { action: 'none', reason: 'The comment has no `/contract approve` command.' };

  const config = resolveConfig(input.config);
  const structure = await checkContractStructure(input);
  const contract = structure.contract;
  if (!contract?.document || structure.failures.length > 0) {
    const problems = structure.failures.map((f) => f.message).join(' ');
    return { action: 'refuse', reason: `The Change Contract can't be approved yet. ${problems}`.trim() };
  }

  const refusal = refusalUnderPolicy(comment, input.pr.author, config);
  if (refusal) return { action: 'refuse', reason: `${comment.author} may not approve under the Sign-off Policy: ${refusal}` };

  const hashes = commands.map((c) => c.hash ?? contract.hash);
  if (!hashes.includes(contract.hash)) {
    return {
      action: 'refuse',
      reason: `The comment approves ${hashes.join(', ')}, but the Change Contract's hash is ${contract.hash}. Approve the current Contract Version.`,
    };
  }

  const existing = checkApproval({ ...input, comments: [...input.comments, comment] }, contract, config);
  if (existing.approval) {
    return { action: 'already-approved', reason: `Change Contract ${contract.path} is already approved in ${shortSha(existing.approval.commit)}.` };
  }

  const code = commitsAfter(contract, input.commits).find((c) => c.files.length > 0);
  if (code) {
    return {
      action: 'refuse',
      reason: `Commit ${shortSha(code.sha)} already contains code, and code is allowed only after the Contract Approval. Drop the code commits, then approve again.`,
    };
  }

  return {
    action: 'push',
    parent: input.pr.head,
    message: [
      `Approve Change Contract ${contract.document.slug}`,
      '',
      `Contract-Hash: ${contract.hash}`,
      `Approved-By: ${comment.author}`,
      `Approval-Comment: ${comment.url}`,
    ].join('\n'),
  };
}
