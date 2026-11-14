import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFixtureRepo, loadFixture, type FixtureCommit } from '../../../fixtures/build-fixture.js';

const bin = fileURLToPath(new URL('../bin/contract.js', import.meta.url));
const builtRepos: string[] = [];
afterAll(() => builtRepos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const CONTRACT = `${JSON.stringify(
  {
    version: 1,
    slug: 'say-hi',
    summary: 'Greet with hi.',
    scope: { files: ['src/greet.ts'], symbols: ['src/greet.ts#greet'] },
  },
  null,
  2,
)}\n`;
const AGENT = { name: 'Agent Operator', email: 'operator@example.com' };
/** The bot identity `contract check` expects when the repo has no gate config. */
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

async function repoWith(code: Record<string, string>) {
  const commits: FixtureCommit[] = [
    { author: AGENT, message: 'Add Change Contract: say-hi', files: { '.contracts/say-hi.json': CONTRACT } },
    {
      author: BOT,
      message:
        'Approve Change Contract say-hi\n\nContract-Hash: {{contractHash}}\nApproved-By: reviewer\nApproval-Comment: https://code.example/pr/1#comment-1',
      files: {},
    },
    { author: AGENT, message: 'Say hi', files: code },
  ];
  const repo = await buildFixtureRepo(loadFixture(JSON.stringify({ description: '', pr: { author: 'x' }, commits })));
  builtRepos.push(repo.dir);
  return repo;
}

function contract(cwd: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const GREET = 'export function greet(name: string): string {\n  return `Hi, ${name}`;\n}\n';

describe('contract check', () => {
  it('passes a branch that stays within its approved Change Contract', async () => {
    const repo = await repoWith({ 'src/greet.ts': GREET });

    const run = contract(repo.dir, 'check', '--base', 'main', '--head', 'pr');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('## Change Contract gate: ✅ pass');
    expect(run.stdout).toContain(
      "- Checked locally: comments aren't available, so the approval comment and Sign-offs weren't verified.",
    );
  });

  it('lists each Deviation with the exact command to sign it off, and exits 1', async () => {
    const repo = await repoWith({ 'src/greet.ts': GREET, 'src/farewell.ts': 'export const bye = 1;\n' });
    const json = contract(repo.dir, 'check', '--base', 'main', '--head', 'pr', '--json');
    const [deviation] = JSON.parse(json.stdout).deviations;

    const run = contract(repo.dir, 'check', '--base', 'main', '--head', 'pr');

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('## Change Contract gate: ❌ fail');
    expect(run.stdout).toContain(
      `| \`${deviation.id}\` | Unplanned Change | \`src/farewell.ts\` | unsigned | \`/signoff ${deviation.id} accept "<reason>"\` |`,
    );
    expect(run.stdout).toContain(`- \`${deviation.id}\`: src/farewell.ts is added, but no scope Clause covers it.`);
  });

  it('writes a run summary for the pilot metrics', async () => {
    const repo = await repoWith({ 'src/greet.ts': GREET, 'src/farewell.ts': 'export const bye = 1;\n' });
    const file = join(repo.dir, 'run-summary.json');

    contract(repo.dir, 'check', '--base', 'main', '--head', 'pr', '--run-summary', file);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      status: 'fail',
      deviations: { total: 1, byKind: { 'unplanned-change': 1 }, byCheck: { scope: 1 } },
      signoffs: { accepted: 0, rejected: 0, unsigned: 1 },
    });
  });

  it('exits 2 without --base', async () => {
    const repo = await repoWith({ 'src/greet.ts': GREET });

    const run = contract(repo.dir, 'check');

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Usage: contract check --base <ref>');
  });
});
