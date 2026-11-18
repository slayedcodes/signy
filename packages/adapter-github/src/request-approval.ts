import { contractHash, isContractFile } from '@change-contract/core';
import type { GitHubApi } from './github-api.js';

export interface ApprovalRequest {
  /** The Change Contract's path in the PR. */
  path: string;
  /** Its Contract Version, as `sha256:<hex>`. */
  hash: string;
  /** The `/contract approve` comment that was posted. */
  commentUrl: string;
}

/** The PR can't take a Contract Approval as it stands; nothing was posted. */
export class ApprovalRefused extends Error {}

/**
 * Posts `/contract approve sha256:<hash>` on a PR, as whoever owns the token. The hash is the
 * Contract Version the gate checks: the Change Contract that commit 1 (the Contract Commit)
 * adds. Naming it ties the Contract Approval to exactly what the approver read.
 */
export async function requestApproval(api: GitHubApi, repo: string, number: number): Promise<ApprovalRequest> {
  const [first] = await api.pullCommitShas(number);
  const added = first ? (await api.commitFiles(first)).filter((f) => isContractFile(f.path) && f.status === 'added') : [];
  if (!first || added.length !== 1) {
    const found = added.length === 0 ? 'none' : added.map((f) => f.path).join(', ');
    throw new ApprovalRefused(`Commit 1 of ${repo}#${number} must add exactly one Change Contract under .contracts/; it adds ${found}.`);
  }
  const path = added[0]!.path;
  const pull = await api.pull(number);
  const approved = await api.fileContent(path, first);
  const current = await api.fileContent(path, pull.headSha).catch(() => undefined);
  if (current !== approved) {
    throw new ApprovalRefused(
      `${path} changed after the Contract Commit, so the gate won't accept any Contract Approval on this PR. A new Contract Version needs a new PR.`,
    );
  }
  const hash = contractHash(approved);
  const commentUrl = await api.createComment(number, `/contract approve ${hash}`);
  return { path, hash, commentUrl };
}
