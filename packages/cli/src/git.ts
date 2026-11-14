import { execFileSync } from 'node:child_process';
import type { FileChange, FileChangeStatus, GateCommit, GitReader } from '@change-contract/core';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A GitReader backed by the local `git` binary. */
export function createGitReader(dir: string): GitReader {
  return {
    async readFile(ref, path) {
      try {
        return git(dir, ['show', `${ref}:${path}`]);
      } catch {
        return undefined;
      }
    },
  };
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** The commits in `base..head`, oldest first, each with its author and changed files. */
export function readCommits(dir: string, base: string, head: string): GateCommit[] {
  const log = git(dir, ['log', '--reverse', `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`, `${base}..${head}`]);
  return log
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', name = '', email = '', message = ''] = record.split(FIELD);
      return { sha, author: { name, email }, message: message.trim(), files: readFileChanges(dir, sha) };
    });
}

const STATUS: Record<string, FileChangeStatus> = { A: 'added', M: 'modified', D: 'deleted' };

function readFileChanges(dir: string, sha: string): FileChange[] {
  // --no-renames reports a rename as delete + add, so a replaced contract file is always visible.
  const out = git(dir, ['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', '--name-status', sha]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code = '', path = ''] = line.split('\t');
      return { path, status: STATUS[code[0] ?? ''] ?? 'modified' };
    });
}
