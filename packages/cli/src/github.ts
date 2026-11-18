import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { GitHubApi, type GitHubConnection } from '@change-contract/adapter-github';
import type { Io } from './main.js';

const run = promisify(execFile);

/** A GitHub connection for the PR a command is about. */
export interface PullConnection {
  api: GitHubApi;
  connection: GitHubConnection;
  number: number;
}

/** `gh auth token`, if the GitHub CLI is installed and logged in. */
export async function ghAuthToken(): Promise<string | undefined> {
  try {
    return (await run('gh', ['auth', 'token'])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Connects to the PR a command is about:
 * - the token comes from GITHUB_TOKEN, GH_TOKEN or `gh auth token`
 * - the repo from `--repo` or the origin remote
 * - the PR from `--pr`, or the open PR for the checked-out branch
 */
export async function connectToPull(io: Io, flags: { repo?: string; pr?: string }): Promise<PullConnection> {
  const env = io.env ?? {};
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || (await (io.ghToken ?? ghAuthToken)());
  if (!token) throw new Error('No GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`.');
  const repo = flags.repo ?? (await originRepo(io.cwd));
  const connection: GitHubConnection = {
    repo,
    token,
    fetch: io.fetch ?? ((url, init) => fetch(url, init)),
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
  };
  const api = new GitHubApi(connection);
  if (flags.pr !== undefined) {
    const number = Number(flags.pr);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`--pr ${flags.pr} isn't a PR number.`);
    return { api, connection, number };
  }
  const branch = (await git(io.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const pull = branch && branch !== 'HEAD' ? await api.openPullForBranch(branch) : undefined;
  if (!pull) throw new Error(`No open PR for ${branch ? `branch ${branch}` : 'this checkout'} in ${repo}; pass --pr <number>.`);
  return { api, connection, number: pull.number };
}

/** `owner/name` from the origin remote: `https://github.com/o/r(.git)` or `git@github.com:o/r(.git)`. */
async function originRepo(cwd: string): Promise<string> {
  const url = (await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error('Pass --repo <owner/name>: the origin remote isn\'t a GitHub repository.');
  return match[1]!;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout;
}

/**
 * Runs a command about one PR: reads `--pr` and `--repo`, connects, and runs `body`. A usage or
 * setup problem exits 2; any other error is reported by `onError`, which picks the exit code.
 */
export async function runPullCommand(
  args: string[],
  io: Io,
  usage: string,
  body: (pull: PullConnection) => Promise<number>,
  onError: (error: Error, where: string) => { message: string; status: number },
): Promise<number> {
  let flags;
  try {
    flags = parseArgs({ args, options: { pr: { type: 'string' }, repo: { type: 'string' } } }).values;
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${usage}`);
    return 2;
  }
  let pull: PullConnection;
  try {
    pull = await connectToPull(io, flags);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  try {
    return await body(pull);
  } catch (error) {
    const { message, status } = onError(error as Error, `${pull.connection.repo}#${pull.number}`);
    io.stderr(`${message}\n`);
    return status;
  }
}
