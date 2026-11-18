import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';
import { main, type Io } from '../src/main.js';
import { buildFixtureRepo, loadFixture, type FixtureCommit } from '../../../fixtures/build-fixture.js';
import { fakeGitHub, type FakeComment } from '../../adapter-github/test/fake-github.js';

const GITHUB_BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const AGENT = { name: 'Agent Operator', email: 'operator@example.com' };
const CONTRACT =
  '{\n  "version": 1,\n  "slug": "say-hi",\n  "summary": "Greet with hi.",\n  "scope": { "files": ["src/greet.ts"], "symbols": ["src/greet.ts#greet"] }\n}\n';
const CONTRACT_HASH = `sha256:${createHash('sha256').update(CONTRACT).digest('hex')}`;

const contractCommit: FixtureCommit = { author: AGENT, message: 'Add Change Contract: say-hi', files: { '.contracts/say-hi.json': CONTRACT } };
const approvalCommit: FixtureCommit = {
  author: GITHUB_BOT,
  message: `Approve Change Contract say-hi\n\nContract-Hash: {{contractHash}}\nApproved-By: reviewer\nApproval-Comment: https://github.com/acme/pilot/pull/7#issuecomment-1`,
  files: {},
};
const approveComment: FakeComment = { id: 1, login: 'reviewer', body: '/contract approve', createdAt: '2023-11-14T22:15:00Z' };

async function pr(commits: FixtureCommit[], comments: FakeComment[] = [], verified: number[] = []) {
  const spec = { description: '', pr: { author: 'agent-operator', branch: 'claude/say-hi' }, bot: GITHUB_BOT, commits };
  const repo = await buildFixtureRepo(loadFixture(JSON.stringify(spec)));
  onTestFinished(() => rmSync(repo.dir, { recursive: true, force: true }));
  const gh = fakeGitHub({
    repoDir: repo.dir,
    prAuthor: 'agent-operator',
    base: repo.base,
    head: repo.head,
    verified: verified.map((n) => repo.shas[n - 1]!),
    comments,
    permissions: { reviewer: ['write', 'write'] },
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: repo.dir,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { GITHUB_TOKEN: 'test-token' },
    fetch: gh.fetch,
  };
  return { repo, gh, io, out, err };
}

const codeCommit: FixtureCommit = {
  author: AGENT,
  message: 'Say hi',
  files: {
    'src/greet.ts': 'export function greet(name: string): string {\n  return `Hi, ${name}`;\n}\n',
    'src/farewell.ts': 'export const farewell = (n: string): string => `Bye, ${n}`;\n',
    'src/extra.ts': 'export const extra = 1;\n',
  },
};

describe('contract feedback', () => {
  it('prints rejected and unsigned Deviations as instructions for the Producing Agent', async () => {
    const reject = (id: string): FakeComment => ({ id: 2, login: 'reviewer', body: `/signoff ${id} reject "Not part of this change."`, createdAt: '2023-11-14T23:00:00Z' });
    // A first run, with no Sign-off yet, gives the Deviation IDs.
    const first = await pr([contractCommit, approvalCommit, codeCommit], [approveComment], [2]);
    await main(['feedback', '--repo', 'acme/pilot', '--pr', '7'], first.io);
    const farewell = /- (D[0-9a-f]{16}) \(Unplanned Change, scope\) src\/farewell\.ts/.exec(first.out.join(''))![1]!;

    const { io, out, gh } = await pr([contractCommit, approvalCommit, codeCommit], [approveComment, reject(farewell)], [2]);
    const status = await main(['feedback', '--repo', 'acme/pilot', '--pr', '7'], io);

    expect(status).toBe(1);
    expect(gh.writes()).toEqual([]);
    const text = out.join('');
    expect(text).toMatch(
      new RegExp(
        [
          "^The Change Contract gate fails on acme/pilot#7\\. Rework the change until it passes\\. Keep the Change Contract as approved: a change of scope needs a new Contract Version and a fresh Contract Approval, so ask your user instead\\.",
          '',
          '## Rejected Deviations: rework these',
          '',
          `- ${farewell} \\(Unplanned Change, scope\\) src/farewell\\.ts: src/farewell\\.ts is added, but no scope Clause covers it\\.`,
          '  reviewer rejected it: "Not part of this change\\."',
          '',
          '## Unsigned Deviations: remove these, or explain them in the PR description so a reviewer can sign them off',
          '',
          '- D[0-9a-f]{16} \\(Unplanned Change, scope\\) src/extra\\.ts: src/extra\\.ts is added, but no scope Clause covers it\\.',
          '',
          'Then run `contract check --base origin/main` and push\\.',
          '$',
        ].join('\\n'),
      ),
    );
  });

  it('says to wait, not rework, while the Change Contract awaits its Contract Approval', async () => {
    const { io, out } = await pr([contractCommit], []);

    const status = await main(['feedback', '--repo', 'acme/pilot', '--pr', '7'], io);

    expect(status).toBe(1);
    expect(out.join('')).toBe(
      'The Change Contract on acme/pilot#7 is waiting for its Contract Approval. Push no code until the Approval Commit is on the branch; ask your user to approve it.\n',
    );
  });

  it('exits 2, not 1, when it cannot run the gate', async () => {
    const { io, err } = await pr([contractCommit]);

    const status = await main(['feedback', '--repo', 'acme/pilot', '--pr', '8'], io);

    expect(status).toBe(2);
    expect(err.join('')).toMatch(/^Couldn't run the gate on acme\/pilot#8: GitHub API GET \/pulls\/8 failed with 404/);
  });

  it('says there is nothing to rework when the gate passes', async () => {
    const { io, out } = await pr([contractCommit, approvalCommit], [approveComment], [2]);

    const status = await main(['feedback', '--repo', 'acme/pilot', '--pr', '7'], io);

    expect(status).toBe(0);
    expect(out.join('')).toBe('The Change Contract gate passes on acme/pilot#7. Nothing to rework.\n');
  });
});

describe('contract approve', () => {
  it("posts /contract approve with the hash of the PR's Change Contract", async () => {
    const { gh, io, out, err } = await pr([contractCommit]);

    const status = await main(['approve', '--repo', 'acme/pilot', '--pr', '7'], io);

    expect(err.join('')).toBe('');
    expect(status).toBe(0);
    expect(gh.writes()).toEqual([
      { method: 'POST', path: '/repos/acme/pilot/issues/7/comments', body: { body: `/contract approve ${CONTRACT_HASH}` } },
    ]);
    expect(out.join('')).toBe(
      `Approved .contracts/say-hi.json (${CONTRACT_HASH}) on acme/pilot#7: https://github.com/acme/pilot/pull/7#issuecomment-900\nThe gate records it as an Approval Commit on the PR branch.\n`,
    );
  });

  it("finds the PR from the checked-out branch and the repo from the origin remote", async () => {
    const { repo, gh, io } = await pr([contractCommit]);
    execFileSync('git', ['checkout', '-q', '-b', 'claude/say-hi', repo.head], { cwd: repo.dir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/pilot.git'], { cwd: repo.dir });

    const status = await main(['approve'], io);

    expect(status).toBe(0);
    expect(gh.writes()[0]).toMatchObject({ path: '/repos/acme/pilot/issues/7/comments' });
  });

  it("refuses when the Change Contract changed after commit 1, since the gate approves commit 1's version", async () => {
    const edit: FixtureCommit = { author: AGENT, message: 'Widen scope', files: { '.contracts/say-hi.json': CONTRACT.replace('Greet with hi.', 'Greet.') } };
    const { gh, io, err } = await pr([contractCommit, edit]);

    const status = await main(['approve', '--repo', 'acme/pilot', '--pr', '7'], io);

    expect(status).toBe(1);
    expect(gh.writes()).toEqual([]);
    expect(err.join('')).toBe(
      ".contracts/say-hi.json changed after the Contract Commit, so the gate won't accept any Contract Approval on this PR. A new Contract Version needs a new PR.\n",
    );
  });

  it('refuses when commit 1 adds no Change Contract', async () => {
    const { gh, io, err } = await pr([{ author: AGENT, message: 'Code', files: { 'src/x.ts': 'export {};\n' } }]);

    const status = await main(['approve', '--repo', 'acme/pilot', '--pr', '7'], io);

    expect(status).toBe(1);
    expect(gh.writes()).toEqual([]);
    expect(err.join('')).toBe('Commit 1 of acme/pilot#7 must add exactly one Change Contract under .contracts/; it adds none.\n');
  });

  it('needs a token', async () => {
    const { io, err } = await pr([contractCommit]);

    const status = await main(['approve', '--repo', 'acme/pilot', '--pr', '7'], { ...io, env: {}, ghToken: async () => undefined });

    expect(status).toBe(2);
    expect(err.join('')).toBe('No GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`.\n');
  });
});
