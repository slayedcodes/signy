import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runGate } from '@change-contract/core';
import { createGitReader, readCommits } from '@change-contract/cli';
import { buildFixtureRepo, loadFixture, resolveExpected } from './build-fixture.js';

const fixturesDir = fileURLToPath(new URL('.', import.meta.url));
const fixtureNames = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const builtRepos: string[] = [];
afterAll(() => builtRepos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const readText = (...segments: string[]) => readFileSync(join(fixturesDir, ...segments), 'utf8');

describe('gate fixtures', () => {
  it.each(fixtureNames)('%s', async (name) => {
    const fixture = loadFixture(readText(name, 'fixture.json'));
    const repo = buildFixtureRepo(fixture);
    builtRepos.push(repo.dir);
    const expected = resolveExpected(readText(name, 'expected.json'), repo, fixture);

    const result = await runGate({
      pr: { ...fixture.pr, base: repo.base, head: repo.head },
      commits: readCommits(repo.dir, repo.base, repo.head),
      git: createGitReader(repo.dir),
      comments: fixture.comments,
      config: fixture.config,
      bot: fixture.bot,
    });

    expect(result).toEqual(expected);
  });
});
