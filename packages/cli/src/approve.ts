import { ApprovalRefused, requestApproval } from '@change-contract/adapter-github';
import { runPullCommand } from './github.js';
import type { Io } from './main.js';

const USAGE = 'Usage: contract approve [--pr <number>] [--repo <owner/name>]\n';

/**
 * `contract approve`: for the human reviewer. Posts `/contract approve sha256:<hash>` on the PR
 * with the reviewer's own token, naming the Contract Version the gate checks. Exit 0 when
 * posted, 1 when the PR can't take a Contract Approval or GitHub refuses, 2 on a usage or setup error.
 */
export function approve(args: string[], io: Io): Promise<number> {
  return runPullCommand(
    args,
    io,
    USAGE,
    async ({ api, connection, number }) => {
      const request = await requestApproval(api, connection.repo, number);
      io.stdout(
        `Approved ${request.path} (${request.hash}) on ${connection.repo}#${number}: ${request.commentUrl}\nThe gate records it as an Approval Commit on the PR branch.\n`,
      );
      return 0;
    },
    (error, where) => ({ message: error instanceof ApprovalRefused ? error.message : `Couldn't approve ${where}: ${error.message}`, status: 1 }),
  );
}
