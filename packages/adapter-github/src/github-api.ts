import type { Permission } from '@change-contract/core';

/** The part of `fetch` the client uses. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Where and as whom the client talks to GitHub. */
export interface GitHubConnection {
  /** `owner/name`. */
  repo: string;
  token: string;
  fetch: Fetch;
  /** Default https://api.github.com. */
  apiUrl?: string;
  /** Default `<apiUrl>/graphql`; GitHub Enterprise Server differs. */
  graphqlUrl?: string;
}

export interface PullRequest {
  number: number;
  author: string;
  labels: string[];
  headRef: string;
  headSha: string;
  /** `owner/name` of the repo the head branch lives in; differs from the base repo for forks. */
  headRepo: string;
  baseRef: string;
  baseSha: string;
}

export interface IssueComment {
  id: number;
  url: string;
  body: string;
  author: string;
  isBot: boolean;
  createdAt: string;
}

export interface CheckRunOutput {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    message: string,
  ) {
    super(`GitHub API ${route} failed with ${status}: ${message}`);
  }
}

/** The few REST endpoints the adapter uses, over an injectable `fetch` so tests can replay responses. */
export class GitHubApi {
  private readonly permissions = new Map<string, Promise<Permission>>();

  constructor(private readonly options: GitHubConnection) {}

  private headers(json: boolean): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.options.token}`,
      'x-github-api-version': '2022-11-28',
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.options.apiUrl ?? 'https://api.github.com'}/repos/${this.options.repo}${path}`;
    const response = await this.options.fetch(url, {
      method,
      headers: this.headers(body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) throw new GitHubApiError(response.status, `${method} ${path}`, json.message ?? response.statusText);
    return json;
  }

  /** Every page of a list endpoint. */
  private async all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  async pull(number: number): Promise<PullRequest> {
    const pr = await this.request<any>('GET', `/pulls/${number}`);
    return {
      number: pr.number,
      author: pr.user.login,
      labels: pr.labels.map((l: { name: string }) => l.name),
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      headRepo: pr.head.repo?.full_name ?? '',
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
    };
  }

  /** SHAs of the PR's commits whose signature GitHub verified. GitHub lists at most 250 commits. */
  async verifiedCommits(number: number): Promise<Set<string>> {
    const commits = await this.all<any>(`/pulls/${number}/commits`);
    return new Set(commits.filter((c) => c.commit.verification?.verified === true).map((c) => c.sha as string));
  }

  /**
   * The PR's comments. Anyone with write access can edit anyone's comment, so a comment's
   * words belong to whoever edited it last: `author` is the last editor when there is one.
   */
  async comments(number: number): Promise<IssueComment[]> {
    const [comments, editors] = await Promise.all([this.all<any>(`/issues/${number}/comments`), this.commentEditors(number)]);
    return comments.map((c) => {
      const editor = editors.get(c.id);
      const editedByOther = editor !== undefined && editor.toLowerCase() !== c.user.login.toLowerCase();
      return {
        id: c.id,
        url: c.html_url,
        body: c.body ?? '',
        author: editedByOther ? editor : c.user.login,
        isBot: !editedByOther && c.user.type === 'Bot',
        createdAt: c.created_at,
      };
    });
  }

  /** Comment ID → the login that last edited it. The REST API doesn't say; GraphQL does. */
  private async commentEditors(number: number): Promise<Map<number, string>> {
    const [owner, name] = this.options.repo.split('/');
    const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100, after: $after) {
        nodes { databaseId editor { login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
    const editors = new Map<number, string>();
    let after: string | null = null;
    do {
      const url = this.options.graphqlUrl ?? `${this.options.apiUrl ?? 'https://api.github.com'}/graphql`;
      const response = await this.options.fetch(url, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ query, variables: { owner, name, number, after } }),
      });
      const json = (await response.json()) as any;
      if (!response.ok || json.errors) {
        throw new GitHubApiError(response.status, 'POST /graphql', json.errors?.[0]?.message ?? response.statusText);
      }
      const page = json.data.repository.pullRequest.comments;
      for (const node of page.nodes) if (node.editor?.login) editors.set(node.databaseId, node.editor.login);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return editors;
  }

  /**
   * The login's permission on the repo. `role_name` tells `maintain` and `triage` apart,
   * which the older `permission` field folds into `write` and `read`.
   */
  permission(login: string): Promise<Permission> {
    if (!this.permissions.has(login)) {
      this.permissions.set(
        login,
        this.request<any>('GET', `/collaborators/${encodeURIComponent(login)}/permission`).then(
          (p) => (['admin', 'maintain', 'write', 'triage', 'read'].includes(p.role_name) ? p.role_name : p.permission) as Permission,
          (error) => {
            if (error instanceof GitHubApiError && error.status === 404) return 'none' as Permission;
            throw error;
          },
        ),
      );
    }
    return this.permissions.get(login)!;
  }

  async createCheckRun(headSha: string, output: CheckRunOutput): Promise<void> {
    await this.request('POST', '/check-runs', {
      name: 'change-contract',
      head_sha: headSha,
      status: 'completed',
      conclusion: output.conclusion,
      output: { title: output.title, summary: output.summary },
    });
  }

  async createComment(number: number, body: string): Promise<void> {
    await this.request('POST', `/issues/${number}/comments`, { body });
  }

  async updateComment(id: number, body: string): Promise<void> {
    await this.request('PATCH', `/issues/comments/${id}`, { body });
  }

  async commitTree(sha: string): Promise<string> {
    return (await this.request<any>('GET', `/git/commits/${sha}`)).tree.sha;
  }

  /**
   * Creates a commit through the API. With no author given, GitHub authors it as the token's
   * identity (github-actions[bot] for GITHUB_TOKEN) and signs it, so it shows as verified.
   */
  async createCommit(message: string, tree: string, parents: string[]): Promise<{ sha: string; verified: boolean }> {
    const commit = await this.request<any>('POST', '/git/commits', { message, tree, parents });
    return { sha: commit.sha, verified: commit.verification?.verified === true };
  }

  /** Moves a branch to `sha`. Never forced: if someone pushed meanwhile, GitHub refuses. */
  async fastForward(branch: string, sha: string): Promise<void> {
    const path = branch.split('/').map(encodeURIComponent).join('/');
    await this.request('PATCH', `/git/refs/heads/${path}`, { sha, force: false });
  }
}
