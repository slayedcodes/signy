import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, onTestFinished } from 'vitest';
import { runGate, type Deviation, type GateComment } from '@change-contract/core';
import { createGitReader, readCommits } from '@change-contract/cli';
import { buildFixtureRepo, loadFixture, resolveExpected, type Fixture, type FixtureRepo } from './build-fixture.js';

const fixturesDir = fileURLToPath(new URL('.', import.meta.url));
const fixtureNames = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const readText = (...segments: string[]) => readFileSync(join(fixturesDir, ...segments), 'utf8');

async function gate(fixture: Fixture, repo: FixtureRepo, head: string, comments: GateComment[]) {
  const commits = await readCommits(repo.dir, repo.base, head);
  if (fixture.host.verifiesSignatures) {
    for (const commit of commits) commit.signatureVerified = fixture.commits[repo.shas.indexOf(commit.sha)]?.signatureVerified ?? false;
  }
  return runGate({
    pr: { ...fixture.pr, base: repo.base, head },
    commits,
    hostVerifiesSignatures: fixture.host.verifiesSignatures ?? false,
    git: createGitReader(repo.dir),
    comments,
    config: fixture.config,
    bot: fixture.bot,
  });
}

// The key may itself contain "@" (scoped packages such as @types/node); only a trailing @N is a commit.
const DEVIATION_PLACEHOLDER = /\{\{(id|fingerprint):([^}]+?)(?:@(\d+))?\}\}/g;

/**
 * Replaces `{{id:<kind>:<check>:<target>}}` and `{{fingerprint:…}}` with the matching
 * Deviation's display ID or fingerprint. A `@N` suffix means "as of PR commit N", which
 * lets a fixture sign off a Deviation that a later commit changes.
 */
async function resolveDeviations(text: string, fixture: Fixture, repo: FixtureRepo): Promise<string> {
  const byHead = new Map<string, Deviation[]>();
  const deviationsAt = async (head: string) => {
    if (!byHead.has(head)) byHead.set(head, (await gate(fixture, repo, head, [])).deviations);
    return byHead.get(head)!;
  };
  const replacements = new Map<string, string>();
  for (const [placeholder, field, key, n] of text.matchAll(DEVIATION_PLACEHOLDER)) {
    const head = n === undefined ? repo.head : repo.shas[Number(n) - 1];
    if (!head) throw new Error(`${placeholder} refers to commit ${n}, which doesn't exist`);
    const deviation = (await deviationsAt(head)).find((d) => `${d.kind}:${d.check}:${d.target}` === key);
    if (!deviation) throw new Error(`${placeholder}: no such Deviation at ${n ? `commit ${n}` : 'head'}`);
    replacements.set(placeholder, field === 'id' ? deviation.id : deviation.fingerprint);
  }
  return text.replace(DEVIATION_PLACEHOLDER, (placeholder) => replacements.get(placeholder)!);
}

describe('gate fixtures', () => {
  // Sequential on purpose: git process start-up dominates, and on Windows parallel builds contend badly.
  it.for(fixtureNames)('%s', async (name, { expect }) => {
    const fixture = loadFixture(readText(name, 'fixture.json'));
    const repo = await buildFixtureRepo(fixture);
    // Each fixture removes its own repo; one sweep at the end outlasts vitest's hook timeout on Windows.
    onTestFinished(() => rmSync(repo.dir, { recursive: true, force: true }));
    const comments = JSON.parse(
      await resolveDeviations(JSON.stringify(fixture.comments), fixture, repo),
    ) as GateComment[];
    const expected = resolveExpected(await resolveDeviations(readText(name, 'expected.json'), fixture, repo), repo, fixture);

    const result = await gate(fixture, repo, repo.head, comments);

    expect(result).toEqual(expected);
  });
});
