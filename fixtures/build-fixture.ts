import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BotIdentity, GateComment, GateConfig } from '@change-contract/core';

export interface FixtureAuthor {
  name: string;
  email: string;
}

export interface FixtureCommit {
  author: FixtureAuthor;
  message: string;
  /** Path → new content, or `null` to delete the file. An empty map makes an empty commit. */
  files: Record<string, string | null>;
}

export interface FixtureSpec {
  description: string;
  pr: { author: string };
  bot: BotIdentity;
  config: GateConfig;
  base: { files: Record<string, string> };
  commits: FixtureCommit[];
  comments: GateComment[];
}

export interface FixtureRepo {
  dir: string;
  base: string;
  head: string;
}

const BASE_AUTHOR: FixtureAuthor = { name: 'Fixture Base', email: 'base@example.com' };

/**
 * Builds a throwaway git repo for a fixture: one base commit, then the PR's
 * commits in order. Dates are fixed so that SHAs are reproducible.
 */
export function buildFixtureRepo(spec: FixtureSpec): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), 'contract-fixture-'));
  const git = (args: string[], author: FixtureAuthor = BASE_AUTHOR, date = 0) =>
    execFileSync(
      'git',
      // Fixture repos are disposable, so they must not inherit the user's signing or line-ending settings.
      ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
          GIT_AUTHOR_DATE: `${1_700_000_000 + date * 60} +0000`,
          GIT_COMMITTER_DATE: `${1_700_000_000 + date * 60} +0000`,
        },
      },
    ).trim();

  try {
    git(['init', '--quiet', '-b', 'main']);
    applyFiles(dir, spec.base.files);
    git(['add', '--all']);
    git(['commit', '--quiet', '--allow-empty', '-m', 'Base']);
    const base = git(['rev-parse', 'HEAD']);

    spec.commits.forEach((commit, i) => {
      applyFiles(dir, commit.files);
      git(['add', '--all']);
      git(['commit', '--quiet', '--allow-empty', '-m', commit.message], commit.author, i + 1);
    });
    const head = git(['rev-parse', 'HEAD']);
    return { dir, base, head };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function applyFiles(dir: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    if (content === null) {
      rmSync(fullPath, { force: true });
    } else {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }
}
