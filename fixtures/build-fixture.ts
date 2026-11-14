import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** fixture.json as written on disk; every field but `description`, `pr.author` and `commits` has a default. */
export interface FixtureSpec {
  description: string;
  pr: { author: string; labels?: string[]; branch?: string };
  bot?: BotIdentity;
  config?: GateConfig;
  base?: { files: Record<string, string> };
  commits: FixtureCommit[];
  comments?: GateComment[];
}

export interface Fixture {
  description: string;
  /** `sha256:<hex>` of the first Change Contract the PR writes, for `{{contractHash}}` in expected.json. */
  contractHash: string;
  pr: { author: string; labels: string[]; branch: string };
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
  /** SHAs of the PR's commits, oldest first. */
  shas: string[];
}

export const DEFAULT_BOT: BotIdentity = {
  name: 'change-contract[bot]',
  email: 'change-contract-bot@users.noreply.example.com',
};

const DEFAULT_BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "pilot", "version": "1.0.0" }\n',
  'src/greet.ts': 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n',
};

/**
 * Parses fixture.json text and fills in defaults. `{{contractHash}}` is replaced with
 * `sha256:<hex>` of the first `.contracts/*.json` file the PR's commits write.
 */
export function loadFixture(text: string): Fixture {
  const raw = JSON.parse(text) as FixtureSpec;
  const contract = raw.commits
    .flatMap((c) => Object.entries(c.files))
    .find(([path, content]) => /^\.contracts\/[^/]+\.json$/.test(path) && content !== null);
  const hash = contract ? `sha256:${createHash('sha256').update(contract[1]!).digest('hex')}` : 'sha256:none';
  const spec = JSON.parse(text.replaceAll('{{contractHash}}', hash)) as FixtureSpec;
  return {
    description: spec.description,
    contractHash: hash,
    pr: { labels: [], branch: 'feature/change', ...spec.pr },
    bot: spec.bot ?? DEFAULT_BOT,
    config: spec.config ?? {},
    base: spec.base ?? { files: DEFAULT_BASE_FILES },
    commits: spec.commits,
    comments: spec.comments ?? [],
  };
}

/** Replaces `{{contractHash}}`, and `{{sha:N}}` / `{{short:N}}` (N is 1-based) with the built commits' SHAs. */
export function resolveExpected(text: string, repo: FixtureRepo, fixture: Fixture): unknown {
  const sha = (n: string) => {
    const value = repo.shas[Number(n) - 1];
    if (value === undefined) throw new Error(`expected.json refers to commit ${n}, which doesn't exist`);
    return value;
  };
  return JSON.parse(
    text
      .replaceAll('{{contractHash}}', fixture.contractHash)
      .replace(/\{\{sha:(\d+)\}\}/g, (_, n: string) => sha(n))
      .replace(/\{\{short:(\d+)\}\}/g, (_, n: string) => sha(n).slice(0, 7)),
  );
}

/**
 * Builds a throwaway git repo for a fixture: one base commit, then the PR's
 * commits in order. Dates are fixed so that SHAs are reproducible.
 */
export function buildFixtureRepo(fixture: Fixture): FixtureRepo {
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
    applyFiles(dir, fixture.base.files);
    git(['add', '--all']);
    git(['commit', '--quiet', '--allow-empty', '-m', 'Base']);
    const base = git(['rev-parse', 'HEAD']);

    const shas = fixture.commits.map((commit, i) => {
      applyFiles(dir, commit.files);
      git(['add', '--all']);
      git(['commit', '--quiet', '--allow-empty', '--cleanup=strip', '-m', commit.message], commit.author, i + 1);
      return git(['rev-parse', 'HEAD']);
    });
    return { dir, base, head: shas.at(-1) ?? base, shas };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const BASE_AUTHOR: FixtureAuthor = { name: 'Fixture Base', email: 'base@example.com' };

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
