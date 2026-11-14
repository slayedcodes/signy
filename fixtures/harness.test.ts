import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runGate } from '@change-contract/core';
import { createGitReader, readCommits } from '@change-contract/cli';
import { buildFixtureRepo, type FixtureSpec } from './build-fixture.js';

const fixturesDir = fileURLToPath(new URL('.', import.meta.url));
const fixtureNames = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const builtRepos: string[] = [];
afterAll(() => builtRepos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(fixturesDir, ...segments), 'utf8')) as T;
}

describe('gate fixtures', () => {
  it.each(fixtureNames)('%s', async (name) => {
    const spec = readJson<FixtureSpec>(name, 'fixture.json');
    const expected = readJson<unknown>(name, 'expected.json');
    const repo = buildFixtureRepo(spec);
    builtRepos.push(repo.dir);

    const result = await runGate({
      pr: { author: spec.pr.author, base: repo.base, head: repo.head },
      commits: readCommits(repo.dir, repo.base, repo.head),
      git: createGitReader(repo.dir),
      comments: spec.comments,
      config: spec.config,
      bot: spec.bot,
    });

    expect(result).toEqual(expected);
  });
});
