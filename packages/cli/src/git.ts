import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitAccess } from '@change-contract/adapter-github';
import type { FileChange, FileChangeStatus, GateCommit, GitReader } from '@change-contract/core';

const run = promisify(execFile);

/** Resolves a ref to a commit SHA. */
export async function resolveRef(dir: string, ref: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** A GitReader backed by the local `git` binary. */
export function createGitReader(dir: string): GitReader {
  return {
    async readFile(ref, path) {
      try {
        return await git(dir, ['show', `${ref}:${path}`]);
      } catch {
        return undefined;
      }
    },
    async diff(base, head) {
      const mergeBase = (await git(dir, ['merge-base', base, head])).trim();
      return { mergeBase, files: await diffFiles(dir, mergeBase, head) };
    },
  };
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/**
 * The commits in `base..head`, oldest first, each with its author and changed files.
 * Ordered by the commit graph, not by commit dates, which anyone can set.
 * One `git log` call lists every ordinary commit's files; only merges need extra diffs.
 */
export async function readCommits(dir: string, base: string, head: string): Promise<GateCommit[]> {
  // Each record: header fields, then the NUL-separated name-status entries git log prints after them.
  const format = `--format=${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%cI${FIELD}%B${FIELD}`;
  // --no-renames reports a rename as delete + add, so a replaced Change Contract is always visible.
  // -z prints paths raw; without it git quotes unusual names, which then match nothing.
  const args = ['log', '-z', '--reverse', '--topo-order', '--no-renames', '--name-status', format, `${base}..${head}`];
  const log = await git(dir, args);
  const commits: GateCommit[] = [];
  for (const record of log.split(RECORD).filter((r) => r.trim())) {
    const [sha = '', parentList = '', name = '', email = '', committedAt = '', message = '', nameStatus = ''] =
      record.split(FIELD);
    const parents = parentList.split(' ').filter(Boolean);
    const files = parents.length > 1 ? await mergeOwnChanges(dir, sha, parents) : parseNameStatus(nameStatus);
    commits.push({ sha, parents, author: { name, email }, message: message.trim(), files, committedAt });
  }
  return commits;
}

const STATUS: Record<string, FileChangeStatus> = { A: 'added', M: 'modified', D: 'deleted' };

/**
 * The files a merge itself changes: only the paths whose result differs from every parent,
 * such as a conflict resolution or an edit slipped in. Changes it brings in from a parent
 * are already accounted for by that parent's own commits, or belong to the base branch.
 */
async function mergeOwnChanges(dir: string, sha: string, parents: string[]): Promise<FileChange[]> {
  const diffs: FileChange[][] = [];
  for (const parent of parents) diffs.push(await diffFiles(dir, parent, sha));
  const [first, ...others] = diffs;
  return first!.filter((change) => others.every((diff) => diff.some((other) => other.path === change.path)));
}

async function diffFiles(dir: string, from: string, to: string): Promise<FileChange[]> {
  return parseNameStatus(await git(dir, ['diff-tree', '-z', '-r', '--no-renames', '--name-status', from, to]));
}

/** Parses `-z --name-status` output: alternating status and path, each NUL-terminated. */
function parseNameStatus(out: string): FileChange[] {
  const fields = out
    .split('\0')
    .map((field) => field.replace(/^\n+/, ''))
    .filter(Boolean);
  const changes: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    changes.push({ path: fields[i + 1]!, status: STATUS[fields[i]![0] ?? ''] ?? 'modified' });
  }
  return changes;
}

/**
 * Git for the GitHub adapter: a reader over the local checkout that can fetch a PR's commits.
 * Missing commits are fetched through `refs/pull/N/head`, which covers branches in forks too,
 * then by SHA (e.g. an Approval Commit the gate just created).
 */
export function createGitAccess(dir: string): GitAccess {
  const isPresent = (sha: string) => git(dir, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
  return {
    reader: createGitReader(dir),
    readCommits: (base, head) => readCommits(dir, base, head),
    async fetchCommits(shas, pull) {
      if ((await Promise.all(shas.map(isPresent))).every(Boolean)) return;
      await git(dir, [
        'fetch', '--no-tags', '--quiet', 'origin',
        `+refs/pull/${pull.number}/head:refs/remotes/change-contract/pr-${pull.number}`,
        `+refs/heads/${pull.baseRef}:refs/remotes/change-contract/base`,
      ]);
      const missing = (await Promise.all(shas.map(async (sha) => ((await isPresent(sha)) ? undefined : sha)))).filter(
        (sha): sha is string => sha !== undefined,
      );
      if (missing.length > 0) await git(dir, ['fetch', '--no-tags', '--quiet', 'origin', ...missing]);
    },
  };
}
