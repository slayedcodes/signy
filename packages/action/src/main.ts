import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { handleEvent, type PullRequest } from '@change-contract/adapter-github';
import { createGitReader, readCommits } from '@change-contract/cli';
import { renderSummary } from '@change-contract/core';

const run = promisify(execFile);
const env = process.env;

/** An Action input, as the runner passes it: `INPUT_<NAME>` with the name upper-cased. */
const input = (name: string) => env[`INPUT_${name.toUpperCase()}`]?.trim() ?? '';

function setOutput(name: string, value: string) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/**
 * Fetches the PR's commits into the checkout. The PR head is fetched through
 * `refs/pull/N/head`, which works for branches in forks too; then any commits by SHA.
 */
async function fetchCommits(dir: string, shas: string[], pull: PullRequest) {
  const git = (args: string[]) => run('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${pull.number}/head:refs/remotes/change-contract/pr-${pull.number}`, `+refs/heads/${pull.baseRef}:refs/remotes/change-contract/base`]);
  const missing: string[] = [];
  for (const sha of shas) {
    if (!(await git(['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false))) missing.push(sha);
  }
  if (missing.length > 0) await git(['fetch', '--no-tags', '--quiet', 'origin', ...missing]);
}

async function main() {
  const dir = env.GITHUB_WORKSPACE ?? process.cwd();
  const event = { name: env.GITHUB_EVENT_NAME ?? '', payload: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')) };
  const outcome = await handleEvent(event, {
    repo: env.GITHUB_REPOSITORY ?? '',
    token: input('github-token'),
    fetch: (url, init) => fetch(url, init),
    apiUrl: env.GITHUB_API_URL,
    graphqlUrl: env.GITHUB_GRAPHQL_URL,
    git: {
      reader: createGitReader(dir),
      readCommits: (base, head) => readCommits(dir, base, head),
      fetchCommits: (shas, pull) => fetchCommits(dir, shas, pull),
    },
  });
  if (!outcome.handled) {
    console.log(outcome.reason);
    setOutput('status', 'skipped');
    return;
  }
  const summaryPath = resolve(dir, input('run-summary') || 'change-contract-run-summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(outcome.runSummary, null, 2)}\n`);
  setOutput('status', outcome.result.status);
  setOutput('run-summary', summaryPath);
  console.log(renderSummary(outcome.result));
}

main().catch((error: unknown) => {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
