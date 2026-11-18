import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleEvent } from '@change-contract/adapter-github';
import { createGitAccess } from '@change-contract/cli';
import { renderSummary } from '@change-contract/core';

const env = process.env;

/** An Action input, as the runner passes it: `INPUT_<NAME>` with the name upper-cased. */
const input = (name: string) => env[`INPUT_${name.toUpperCase()}`]?.trim() ?? '';

function setOutput(name: string, value: string) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
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
    git: createGitAccess(dir),
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
