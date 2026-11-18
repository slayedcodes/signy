import { loadPullRequest } from '@change-contract/adapter-github';
import { renderFeedback, runGate } from '@change-contract/core';
import { createGitAccess } from './git.js';
import { runPullCommand } from './github.js';
import type { Io } from './main.js';

const USAGE = 'Usage: contract feedback [--pr <number>] [--repo <owner/name>]\n';

/**
 * `contract feedback`: for the Producing Agent. Runs the gate on the PR, with its comments and
 * Sign-offs from GitHub, and prints what to do next. It never posts; it may fetch the PR's
 * commits into the checkout. Exit 0 when there is nothing to do, 1 when there is, 2 when it
 * couldn't run the gate.
 */
export function feedback(args: string[], io: Io): Promise<number> {
  return runPullCommand(
    args,
    io,
    USAGE,
    async ({ api, connection, number }) => {
      const { pull, input } = await loadPullRequest(api, createGitAccess(io.cwd), number);
      const result = await runGate(input);
      io.stdout(renderFeedback(result, { pr: `${connection.repo}#${number}`, base: `origin/${pull.baseRef}` }));
      return result.status === 'pass' ? 0 : 1;
    },
    (error, where) => ({ message: `Couldn't run the gate on ${where}: ${error.message}`, status: 2 }),
  );
}
