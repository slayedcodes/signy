import { rmSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createGitReader, readCommits } from '@change-contract/cli';
import { handleEvent, type AdapterDeps } from '../src/index.js';
import { buildFixtureRepo, loadFixture, type FixtureCommit, type FixtureSpec } from '../../../fixtures/build-fixture.js';
import { fakeGitHub, type FakeComment, type FakeState } from './fake-github.js';

const GITHUB_BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const AGENT = { name: 'Agent Operator', email: 'operator@example.com' };
const CO_AUTHOR = '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const APPROVAL_URL = 'https://github.com/acme/pilot/pull/7#issuecomment-1';
const CONTRACT =
  '{\n  "version": 1,\n  "slug": "say-hi",\n  "summary": "Greet with hi.",\n  "scope": { "files": ["src/greet.ts"], "symbols": ["src/greet.ts#greet"] }\n}\n';

const contractCommit: FixtureCommit = {
  author: AGENT,
  message: `Add Change Contract: say-hi${CO_AUTHOR}`,
  files: { '.contracts/say-hi.json': CONTRACT },
};
const approvalCommit = (author = GITHUB_BOT): FixtureCommit => ({
  author,
  message: `Approve Change Contract say-hi\n\nContract-Hash: {{contractHash}}\nApproved-By: reviewer\nApproval-Comment: ${APPROVAL_URL}`,
  files: {},
});
const codeCommit = (greeting = 'Hi'): FixtureCommit => ({
  author: AGENT,
  message: `Say hi instead of hello${CO_AUTHOR}`,
  files: { 'src/greet.ts': `export function greet(name: string): string {\n  return \`${greeting}, \${name}\`;\n}\n` },
});
const approveComment: FakeComment = { id: 1, login: 'reviewer', body: 'Looks right.\n/contract approve', createdAt: '2023-11-14T22:15:00Z' };

interface Scenario {
  commits: FixtureCommit[];
  comments?: FakeComment[];
  /** 1-based PR commits the host reports as signature-verified. */
  verified?: number[];
  state?: Partial<FakeState>;
}

/** A fixture repo for PR #7 of acme/pilot, and a fake GitHub that serves it. */
async function scenario({ commits, comments = [approveComment], verified = [], state = {} }: Scenario) {
  const spec: FixtureSpec = { description: '', pr: { author: 'agent-operator' }, bot: GITHUB_BOT, commits };
  const repo = await buildFixtureRepo(loadFixture(JSON.stringify(spec)));
  onTestFinished(() => rmSync(repo.dir, { recursive: true, force: true }));
  const gh = fakeGitHub({
    repoDir: repo.dir,
    prAuthor: 'agent-operator',
    base: repo.base,
    head: repo.head,
    verified: verified.map((n) => repo.shas[n - 1]!),
    comments: structuredClone(comments),
    permissions: { reviewer: ['write', 'write'], 'agent-operator': ['write', 'write'] },
    ...state,
  });
  const deps: AdapterDeps = {
    repo: 'acme/pilot',
    token: 'test-token',
    fetch: gh.fetch,
    apiUrl: 'https://api.github.com',
    now: () => new Date('2023-11-15T00:00:00Z'),
    git: {
      reader: createGitReader(repo.dir),
      readCommits: (base, head) => readCommits(repo.dir, base, head),
      fetchCommits: async () => {},
    },
  };
  return { repo, gh, deps };
}

const pullRequestEvent = (action = 'synchronize') => ({
  name: 'pull_request_target',
  payload: { action, number: 7, pull_request: { number: 7 } },
});

const commentEvent = (comment: FakeComment, action = 'created') => ({
  name: 'issue_comment',
  payload: {
    action,
    issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/pilot/pulls/7' } },
    comment: { id: comment.id, body: comment.body, user: { login: comment.login, type: comment.bot ? 'Bot' : 'User' } },
  },
});

describe('handleEvent', () => {
  it('pushes a signed, empty Approval Commit for /contract approve, then gates the new head', async () => {
    const { repo, gh, deps } = await scenario({ commits: [contractCommit] });
    const tree = (await gh.fetch('https://api.github.com/repos/acme/pilot/git/commits/' + repo.head).then((r) => r.json())).tree.sha;
    gh.requests.length = 0;

    const outcome = await handleEvent(commentEvent(approveComment), deps);

    const approvalSha = gh.state.head;
    expect(approvalSha).not.toBe(repo.head);
    expect(gh.writes()).toEqual([
      {
        method: 'POST',
        path: '/repos/acme/pilot/git/commits',
        body: {
          message: `Approve Change Contract say-hi\n\nContract-Hash: ${loadFixture(JSON.stringify({ description: '', pr: { author: 'x' }, commits: [contractCommit] })).contractHash}\nApproved-By: reviewer\nApproval-Comment: ${APPROVAL_URL}`,
          tree,
          parents: [repo.head],
        },
      },
      { method: 'PATCH', path: '/repos/acme/pilot/git/refs/heads/claude/say-hi', body: { sha: approvalSha, force: false } },
      expect.objectContaining({ method: 'POST', path: '/repos/acme/pilot/check-runs', body: expect.objectContaining({ head_sha: approvalSha, conclusion: 'success' }) }),
      expect.objectContaining({ method: 'POST', path: '/repos/acme/pilot/issues/7/comments' }),
    ]);
    expect(outcome).toMatchObject({ handled: true, head: approvalSha, result: { status: 'pass', approval: { by: 'reviewer', commit: approvalSha } } });
  });


  it('refuses an approval from the PR author with a reply, and pushes nothing', async () => {
    const byAuthor: FakeComment = { ...approveComment, id: 5, login: 'agent-operator' };
    const { gh, deps } = await scenario({ commits: [contractCommit], comments: [byAuthor] });

    const outcome = await handleEvent(commentEvent(byAuthor), deps);

    expect(gh.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /repos/acme/pilot/issues/7/comments',
      'POST /repos/acme/pilot/check-runs',
      'POST /repos/acme/pilot/issues/7/comments',
    ]);
    expect(gh.writes()[0]!.body.body).toBe(
      '> /contract approve\n\n@agent-operator agent-operator may not approve under the Sign-off Policy: they are the PR author.',
    );
    expect(outcome).toMatchObject({ handled: true, result: { status: 'fail', failures: [{ rule: 'approval-missing' }] } });
  });

  it('pushes nothing when the Contract Version is already approved, e.g. the approval comment is edited', async () => {
    const { gh, deps } = await scenario({ commits: [contractCommit, approvalCommit()], verified: [2] });

    await handleEvent(commentEvent(approveComment, 'edited'), deps);

    expect(gh.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /repos/acme/pilot/check-runs',
      'POST /repos/acme/pilot/issues/7/comments',
    ]);
  });

  it("replies instead of pushing when the PR's branch is in a fork", async () => {
    const { gh, deps } = await scenario({ commits: [contractCommit], state: { headRepo: 'someone/pilot' } });

    await handleEvent(commentEvent(approveComment), deps);

    expect(gh.writes()[0]).toEqual({
      method: 'POST',
      path: '/repos/acme/pilot/issues/7/comments',
      body: { body: expect.stringContaining("can't push an Approval Commit to a branch in a fork") },
    });
    expect(gh.writes().some((w) => w.path.includes('/git/'))).toBe(false);
  });

  it('refuses pull_request events, whose workflow file the PR itself controls (ADR 0005)', async () => {
    const { gh, deps } = await scenario({ commits: [contractCommit] });

    const outcome = await handleEvent({ ...pullRequestEvent(), name: 'pull_request' }, deps);

    expect(outcome).toEqual({
      handled: false,
      reason: 'The gate runs on pull_request_target, never pull_request: on pull_request the PR controls the workflow file (ADR 0005).',
    });
    expect(gh.requests).toEqual([]);
  });

  it("treats a comment's commands as its last editor's, so editing a reviewer's comment forges nothing", async () => {
    const edited: FakeComment = { ...approveComment, editor: 'agent-operator' };
    const { gh, deps } = await scenario({ commits: [contractCommit], comments: [edited] });

    const outcome = await handleEvent(commentEvent(edited, 'edited'), deps);

    expect(gh.writes().some((w) => w.path.includes('/git/'))).toBe(false);
    expect(gh.writes()[0]!.body.body).toContain('@agent-operator agent-operator may not approve under the Sign-off Policy: they are the PR author.');
    expect(outcome).toMatchObject({ result: { failures: [{ rule: 'approval-missing' }] } });
  });

  it('catches up on a valid approval whose own run never pushed, on any later event', async () => {
    const { gh, deps } = await scenario({ commits: [contractCommit] });

    const outcome = await handleEvent(pullRequestEvent(), deps);

    expect(gh.writes().map((w) => `${w.method} ${w.path}`).slice(0, 2)).toEqual([
      'POST /repos/acme/pilot/git/commits',
      'PATCH /repos/acme/pilot/git/refs/heads/claude/say-hi',
    ]);
    expect(outcome).toMatchObject({ head: gh.state.head, result: { status: 'pass' } });
  });

  it('replies and gates the current head when the branch moved while approving', async () => {
    const { repo, gh, deps } = await scenario({ commits: [contractCommit], state: { refuseRefUpdates: true } });

    const outcome = await handleEvent(commentEvent(approveComment), deps);

    const replyBody = gh.writes().find((w) => w.path.endsWith('/issues/7/comments'))!.body.body;
    expect(replyBody).toContain('The PR branch changed while the gate was recording the approval. Comment `/contract approve` again.');
    expect(outcome).toMatchObject({ head: repo.head, result: { failures: [{ rule: 'approval-missing' }] } });
  });

  it('refuses to approve when code is already on the branch, or the hash is not the current Contract Version', async () => {
    const wrongHash: FakeComment = { ...approveComment, id: 3, body: `/contract approve sha256:${'0'.repeat(64)}` };
    const first = await scenario({ commits: [contractCommit], comments: [wrongHash] });
    await handleEvent(commentEvent(wrongHash), first.deps);
    expect(first.gh.writes()[0]!.body.body).toContain(`The comment approves sha256:${'0'.repeat(64)}, but the Change Contract's hash is sha256:`);

    const second = await scenario({ commits: [contractCommit, codeCommit()] });
    await handleEvent(commentEvent(approveComment), second.deps);
    expect(second.gh.writes()[0]!.body.body).toContain('already contains code, and code is allowed only after the Contract Approval.');
  });

  it('replies to a comment command it can\'t read, explaining the syntax', async () => {
    const typo: FakeComment = { id: 4, login: 'reviewer', body: '/contract aprove', createdAt: '2023-11-14T23:00:00Z' };
    const { gh, deps } = await scenario({ commits: [contractCommit, approvalCommit(), codeCommit()], verified: [2], comments: [approveComment, typo] });

    await handleEvent(commentEvent(typo), deps);

    expect(gh.writes()[0]).toEqual({
      method: 'POST',
      path: '/repos/acme/pilot/issues/7/comments',
      body: { body: expect.stringMatching(/^> \/contract aprove\n\n@reviewer Unknown command\. The gate understands \/contract approve/) },
    });
  });

  it("replies that commands are ignored on a PR the gate doesn't apply to", async () => {
    const signoff: FakeComment = { id: 6, login: 'reviewer', body: '/signoff D0123456789abcdef accept "ok"', createdAt: '2023-11-14T23:00:00Z' };
    const human: FixtureCommit = { ...codeCommit(), message: 'Say hi' };
    const { gh, deps } = await scenario({ commits: [human], comments: [signoff], state: { branch: 'feature/hi' } });

    await handleEvent(commentEvent(signoff), deps);

    expect(gh.writes()[0]!.body.body).toContain("@reviewer This PR isn't an Agent-authored PR, so the Change Contract gate doesn't apply and ignores commands.");
  });

  it('still recognizes its summary comment after editing it (GraphQL names bots without [bot])', async () => {
    const summary: FakeComment = {
      id: 78,
      login: 'github-actions[bot]',
      bot: true,
      editor: 'github-actions[bot]',
      body: '<!-- change-contract-summary -->\nold',
      createdAt: '2023-11-14T22:20:00Z',
    };
    const { gh, deps } = await scenario({ commits: [contractCommit, approvalCommit(), codeCommit()], verified: [2], comments: [approveComment, summary] });

    await handleEvent(pullRequestEvent(), deps);

    expect(gh.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /repos/acme/pilot/check-runs',
      'PATCH /repos/acme/pilot/issues/comments/78',
    ]);
  });

  it('ignores comments by bots, so its own summary comment never triggers a run', async () => {
    const { gh, deps } = await scenario({ commits: [contractCommit] });

    const outcome = await handleEvent(commentEvent({ ...approveComment, login: 'github-actions[bot]', bot: true }, 'edited'), deps);

    expect(outcome).toEqual({ handled: false, reason: 'Comments by bots are ignored.' });
    expect(gh.requests).toEqual([]);
  });

  it('updates its summary comment in place and fails the check when the gate fails', async () => {
    const summary: FakeComment = { id: 77, login: 'github-actions[bot]', bot: true, body: '<!-- change-contract-summary -->\nold', createdAt: '2023-11-14T22:20:00Z' };
    const { repo, gh, deps } = await scenario({ commits: [contractCommit, codeCommit()], comments: [summary] });

    await handleEvent(pullRequestEvent(), deps);

    expect(gh.writes()).toEqual([
      expect.objectContaining({ path: '/repos/acme/pilot/check-runs', body: expect.objectContaining({ head_sha: repo.head, conclusion: 'failure', output: expect.objectContaining({ title: 'Change Contract gate: fail' }) }) }),
      { method: 'PATCH', path: '/repos/acme/pilot/issues/comments/77', body: { body: expect.stringContaining('approval-missing') } },
    ]);
  });

  it("rejects an Approval Commit whose signature GitHub didn't verify", async () => {
    const { deps } = await scenario({ commits: [contractCommit, approvalCommit(), codeCommit()], verified: [] });

    const outcome = await handleEvent(pullRequestEvent(), deps);

    expect(outcome).toMatchObject({ result: { status: 'fail', failures: [{ rule: 'approval-not-verified' }, { rule: 'approval-missing' }] } });
  });

  it('reads maintain and triage from role_name, which the permission field folds into write and read', async () => {
    const signoff: FakeComment = { id: 2, login: 'triager', body: '/signoff D0123456789abcdef accept "fine"', createdAt: '2023-11-14T23:00:00Z' };
    const { deps } = await scenario({
      commits: [contractCommit, approvalCommit(), codeCommit()],
      verified: [2],
      comments: [approveComment, signoff],
      state: { permissions: { reviewer: ['write', 'maintain'], triager: ['read', 'triage'] } },
    });

    const outcome = await handleEvent(pullRequestEvent(), deps);

    expect(outcome).toMatchObject({
      result: {
        status: 'pass',
        approval: { by: 'reviewer' },
        commandErrors: [{ rule: 'signoff-not-allowed', author: 'triager', message: expect.stringContaining('their permission is triage') }],
      },
    });
  });

  it("posts a passing check but no comment on a PR the gate doesn't apply to", async () => {
    const human: FixtureCommit = { ...codeCommit(), message: 'Say hi' };
    const { gh, deps } = await scenario({ commits: [human], comments: [], state: { branch: 'feature/hi' } });

    const outcome = await handleEvent(pullRequestEvent('opened'), deps);

    expect(outcome).toMatchObject({ result: { applicable: false, status: 'pass' } });
    expect(gh.writes()).toEqual([
      expect.objectContaining({ path: '/repos/acme/pilot/check-runs', body: expect.objectContaining({ conclusion: 'success', output: expect.objectContaining({ title: 'Change Contract gate: not applicable' }) }) }),
    ]);
  });

  it('posts a passing change-contract check run and a summary comment for an approved PR', async () => {
    const { repo, gh, deps } = await scenario({ commits: [contractCommit, approvalCommit(), codeCommit()], verified: [2] });

    const outcome = await handleEvent(pullRequestEvent(), deps);

    expect(outcome).toMatchObject({ handled: true, head: repo.head, result: { status: 'pass', failures: [] } });
    expect(gh.writes()).toEqual([
      {
        method: 'POST',
        path: '/repos/acme/pilot/check-runs',
        body: {
          name: 'change-contract',
          head_sha: repo.head,
          status: 'completed',
          conclusion: 'success',
          output: { title: 'Change Contract gate: pass', summary: expect.stringContaining('## Change Contract gate: ✅ pass') },
        },
      },
      {
        method: 'POST',
        path: '/repos/acme/pilot/issues/7/comments',
        body: { body: expect.stringMatching(/^<!-- change-contract-summary -->\n## Change Contract gate: ✅ pass/) },
      },
    ]);
  });
});
