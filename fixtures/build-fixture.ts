import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** Make this a merge of the base branch's tip; `files` are then extra edits made inside the merge. */
  mergeBase?: boolean;
  /** Build on PR commit N (1-based) instead of the previous commit, to start a side branch. */
  parent?: number;
  /** Make this a merge of PR commit N (1-based), which must sit on a one-commit side branch. */
  merge?: number;
  /** What the code host reports about this commit's signature, when the fixture's host verifies signatures. */
  signatureVerified?: boolean;
}

/** fixture.json as written on disk; every field but `description`, `pr.author` and `commits` has a default. */
export interface FixtureSpec {
  description: string;
  pr: { author: string; labels?: string[]; branch?: string };
  bot?: BotIdentity;
  config?: GateConfig;
  base?: { files: Record<string, string> };
  /** Commits that land on the base branch after the PR branched off, e.g. other merged PRs. */
  baseUpdates?: FixtureCommit[];
  commits: FixtureCommit[];
  comments?: GateComment[];
  /** Facts a host adapter supplies, e.g. that it verifies commit signatures. */
  host?: { verifiesSignatures?: boolean };
}

export interface Fixture {
  description: string;
  /** `sha256:<hex>` of the first Change Contract the PR writes, for `{{contractHash}}` in expected.json. */
  contractHash: string;
  pr: { author: string; labels: string[]; branch: string };
  bot: BotIdentity;
  config: GateConfig;
  base: { files: Record<string, string> };
  baseUpdates: FixtureCommit[];
  commits: FixtureCommit[];
  comments: GateComment[];
  host: { verifiesSignatures?: boolean };
}

export interface FixtureRepo {
  dir: string;
  /** The base branch's tip, as a host reports it for the PR. */
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
    baseUpdates: spec.baseUpdates ?? [],
    commits: spec.commits,
    comments: spec.comments ?? [],
    host: spec.host ?? {},
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
 * Builds a throwaway git repo for a fixture: one base commit on `main`, a `pr` branch
 * from it, any base updates on `main`, then the PR's commits in order on `pr`.
 *
 * The whole history goes through one `git fast-import`, because spawning git is by far
 * the slowest part of a fixture. Dates are fixed so that SHAs are reproducible.
 */
export async function buildFixtureRepo(fixture: Fixture): Promise<FixtureRepo> {
  const dir = mkdtempSync(join(tmpdir(), 'contract-fixture-'));
  try {
    const stream = new FastImportStream();
    const baseTree = new Map(Object.entries(fixture.base.files));
    const baseMark = stream.commit('main', BASE_AUTHOR, 'Base', baseTree, []);

    let mainTree = baseTree;
    let mainMark = baseMark;
    for (const c of fixture.baseUpdates) {
      mainTree = applyFiles(mainTree, c.files);
      mainMark = stream.commit('main', c.author, c.message, mainTree, [mainMark]);
    }

    // Per PR commit: its mark, tree, and the tree of its first parent (for merging side branches).
    const built: Array<{ mark: number; tree: Tree; parentTree: Tree }> = [];
    let prTree = baseTree;
    let prMark = baseMark;
    const prMarks = fixture.commits.map((c) => {
      if (c.parent !== undefined) ({ mark: prMark, tree: prTree } = built[c.parent - 1]!);
      const parentTree = prTree;
      const parents = [prMark];
      // A clean merge takes every path the other side changed since it branched off.
      if (c.mergeBase) {
        parents.push(mainMark);
        prTree = applyFiles(prTree, changedSince(baseTree, mainTree));
      }
      if (c.merge !== undefined) {
        const side = built[c.merge - 1]!;
        parents.push(side.mark);
        prTree = applyFiles(prTree, changedSince(side.parentTree, side.tree));
      }
      prTree = applyFiles(prTree, c.files);
      prMark = stream.commit('pr', c.author, c.message, prTree, parents);
      built.push({ mark: prMark, tree: prTree, parentTree });
      return prMark;
    });

    await gitIn(dir, ['init', '--quiet', '-b', 'main']);
    const marksFile = join(dir, '.git', 'fixture-marks');
    await gitIn(dir, ['fast-import', '--quiet', `--export-marks=${marksFile}`], stream.text());
    const shaOf = readMarks(marksFile);
    const shas = prMarks.map(shaOf);
    return { dir, base: shaOf(mainMark), head: shas.at(-1) ?? shaOf(baseMark), shas };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const BASE_AUTHOR: FixtureAuthor = { name: 'Fixture Base', email: 'base@example.com' };

type Tree = Map<string, string>;

/** Writes a fast-import stream; each commit lists its full tree, so merges need no special handling. */
class FastImportStream {
  private readonly parts: string[] = [];
  private nextMark = 1;
  private date = 0;

  commit(branch: string, author: FixtureAuthor, message: string, tree: Tree, parents: number[]): number {
    const mark = this.nextMark++;
    const when = `${1_700_000_000 + this.date++ * 60} +0000`;
    const [from, ...merges] = parents;
    this.parts.push(
      `commit refs/heads/${branch}\nmark :${mark}\n`,
      `author ${author.name} <${author.email}> ${when}\ncommitter ${author.name} <${author.email}> ${when}\n`,
      data(`${message}\n`),
      from === undefined ? '' : `from :${from}\n`,
      ...merges.map((m) => `merge :${m}\n`),
      'deleteall\n',
      ...[...tree].map(([path, content]) => `M 100644 inline ${path}\n${data(content)}`),
      '\n',
    );
    return mark;
  }

  text(): string {
    return this.parts.join('');
  }
}

function data(content: string): string {
  return `data ${Buffer.byteLength(content, 'utf8')}\n${content}\n`;
}

function applyFiles(tree: Tree, files: Record<string, string | null>): Tree {
  const next = new Map(tree);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) next.delete(path);
    else next.set(path, content);
  }
  return next;
}

function changedSince(before: Tree, after: Tree): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  for (const [path, content] of after) if (before.get(path) !== content) changes[path] = content;
  for (const path of before.keys()) if (!after.has(path)) changes[path] = null;
  return changes;
}

function readMarks(file: string): (mark: number) => string {
  const shas = new Map(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ') as [string, string]),
  );
  return (mark) => {
    const sha = shas.get(`:${mark}`);
    if (!sha) throw new Error(`fast-import exported no SHA for mark :${mark}`);
    return sha;
  };
}

async function gitIn(dir: string, args: string[], input?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (error) =>
      error ? reject(error) : resolve(),
    );
    child.stdin!.end(input ?? '');
  });
}
