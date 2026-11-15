import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}.json`, import.meta.url), 'utf8');

/** Fills a recorded response's `{{name}}` placeholders; values are inserted as raw JSON text. */
function fill(name: string, values: Record<string, string>): unknown {
  return JSON.parse(recorded(name).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`recorded/${name}.json needs {{${key}}}`);
    return values[key]!;
  }));
}

export interface FakeComment {
  id: number;
  login: string;
  body: string;
  createdAt: string;
  bot?: boolean;
  /** Who last edited the comment, if it was edited. */
  editor?: string;
}

export interface FakeState {
  repoDir: string;
  prAuthor: string;
  labels?: string[];
  branch?: string;
  headRepo?: string;
  base: string;
  head: string;
  /** SHAs the host reports as signature-verified. */
  verified?: string[];
  comments: FakeComment[];
  /** Login → [permission, role_name]. Anyone missing has `read`. */
  permissions: Record<string, [string, string]>;
  /** Make every branch update fail, as if someone pushed while the gate was approving. */
  refuseRefUpdates?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body?: any;
}

/**
 * A stand-in for api.github.com: it answers from the recorded responses and keeps every
 * request. Creating a git commit really creates it in the fixture repo, as GitHub would,
 * so the gate can read it afterwards.
 */
export function fakeGitHub(state: FakeState) {
  const requests: RecordedRequest[] = [];
  const verified = new Set(state.verified ?? []);
  let nextCommentId = 900;
  const str = JSON.stringify;

  const comment = (c: FakeComment) =>
    fill('issue-comment', {
      id: String(c.id),
      body: str(c.body),
      login: c.login,
      userType: c.bot ? 'Bot' : 'User',
      createdAt: c.createdAt,
    });

  const git = async (args: string[], env: Record<string, string> = {}) =>
    (await run('git', args, { cwd: state.repoDir, env: { ...process.env, ...env } })).stdout.trim();

  async function respond(method: string, path: string, query: URLSearchParams, body: any): Promise<[number, unknown]> {
    const route = `${method} ${path}`;
    let m: RegExpExecArray | null;
    if (route === 'POST /graphql') {
      // GraphQL names a bot without the "[bot]" suffix the REST API adds, as GitHub does.
      const actor = (login: string) =>
        login.endsWith('[bot]') ? { login: login.slice(0, -5), __typename: 'Bot' } : { login, __typename: 'User' };
      const nodes = state.comments.map((c) => str({ databaseId: c.id, editor: c.editor ? actor(c.editor) : null }));
      return [200, fill('graphql-comment-editors', { nodes: nodes.join(',') })];
    }
    if (route === 'GET /repos/acme/pilot/pulls/7') {
      return [200, fill('pull', {
        prAuthor: state.prAuthor,
        labels: (state.labels ?? []).map((l) => str({ name: l })).join(','),
        branch: state.branch ?? 'claude/say-hi',
        headRepo: state.headRepo ?? 'acme/pilot',
        head: state.head,
        base: state.base,
      })];
    }
    if (route === 'GET /repos/acme/pilot/pulls/7/commits') {
      if (query.get('page') !== '1') return [200, []];
      const shas = (await git(['rev-list', '--reverse', `${state.base}..${state.head}`])).split('\n').filter(Boolean);
      return [200, shas.map((sha) => fill('pull-commit', {
        sha,
        verified: String(verified.has(sha)),
        reason: verified.has(sha) ? 'valid' : 'unsigned',
      }))];
    }
    if (route === 'GET /repos/acme/pilot/issues/7/comments') {
      return [200, query.get('page') === '1' ? state.comments.map(comment) : []];
    }
    if ((m = /^GET \/repos\/acme\/pilot\/collaborators\/([^/]+)\/permission$/.exec(route))) {
      const login = decodeURIComponent(m[1]!);
      const [permission, roleName] = state.permissions[login] ?? ['read', 'read'];
      return [200, fill('collaborator-permission', { permission, roleName, login })];
    }
    if (route === 'POST /repos/acme/pilot/check-runs') {
      return [201, fill('check-run', { head: body.head_sha, conclusion: body.conclusion })];
    }
    if (route === 'POST /repos/acme/pilot/issues/7/comments') {
      const created = { id: nextCommentId++, login: 'github-actions[bot]', bot: true, body: body.body, createdAt: '2023-11-15T00:00:00Z' };
      state.comments.push(created);
      return [201, comment(created)];
    }
    if ((m = /^PATCH \/repos\/acme\/pilot\/issues\/comments\/(\d+)$/.exec(route))) {
      const existing = state.comments.find((c) => c.id === Number(m![1]));
      if (!existing) return [404, { message: 'Not Found' }];
      existing.body = body.body;
      return [200, comment(existing)];
    }
    if ((m = /^GET \/repos\/acme\/pilot\/git\/commits\/([0-9a-f]+)$/.exec(route))) {
      const sha = m[1]!;
      const tree = await git(['rev-parse', `${sha}^{tree}`]);
      return [200, fill('git-commit', { sha, tree, message: str(await git(['log', '-1', '--format=%B', sha])), parents: '' })];
    }
    if (route === 'POST /repos/acme/pilot/git/commits') {
      // GitHub authors an API commit made with GITHUB_TOKEN as github-actions[bot], and signs it.
      const identity = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
      const env = {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: 'GitHub',
        GIT_COMMITTER_EMAIL: 'noreply@github.com',
        GIT_AUTHOR_DATE: '2023-11-14T22:16:00Z',
        GIT_COMMITTER_DATE: '2023-11-14T22:16:00Z',
      };
      const parents = (body.parents as string[]).flatMap((p) => ['-p', p]);
      const sha = await git(['commit-tree', body.tree, ...parents, '-m', body.message], env);
      verified.add(sha);
      return [201, fill('git-commit', {
        sha,
        tree: body.tree,
        message: str(body.message),
        parents: (body.parents as string[]).map((p) => str({ sha: p })).join(','),
      })];
    }
    if ((m = /^PATCH \/repos\/acme\/pilot\/git\/refs\/heads\/(.+)$/.exec(route))) {
      const branch = decodeURIComponent(m[1]!);
      const ancestor = await git(['merge-base', '--is-ancestor', state.head, body.sha]).then(() => true, () => false);
      if (state.refuseRefUpdates || (!body.force && !ancestor)) return [422, { message: 'Update is not a fast forward' }];
      state.head = body.sha;
      return [200, fill('git-ref', { branch, sha: body.sha })];
    }
    return [404, { message: `Not Found: ${route}` }];
  }

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    const [status, json] = await respond(method, url.pathname, url.searchParams, body);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };

  /** The requests that change something on the host (a GraphQL query only reads). */
  const writes = () => requests.filter((r) => r.method !== 'GET' && r.path !== '/graphql');
  return { fetch, requests, writes, state };
}
