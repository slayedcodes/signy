import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildRunSummary,
  GATE_CONFIG_FILE,
  renderSummary,
  runGate,
  type BotIdentity,
  type GateConfig,
  type GateInput,
} from '@change-contract/core';
import { createGitReader, readCommits, resolveRef } from './git.js';
import type { Io } from './main.js';

const USAGE = 'Usage: contract check --base <ref> [--head <ref>] [--json] [--run-summary <file>]\n';

/** GitHub's Actions bot, which pushes Approval Commits when the gate runs as a GitHub Action. */
const DEFAULT_BOT: BotIdentity = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * `contract check`: the full gate against the working branch, with no code host. Agents run
 * it before pushing. Exit 0 when the gate passes, 1 when it fails, 2 on a usage error.
 */
export async function check(args: string[], io: Io): Promise<number> {
  let options;
  try {
    options = parseArgs({
      args,
      options: {
        base: { type: 'string' },
        head: { type: 'string', default: 'HEAD' },
        json: { type: 'boolean', default: false },
        'run-summary': { type: 'string' },
      },
    }).values;
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!options.base) {
    io.stderr(USAGE);
    return 2;
  }

  const git = createGitReader(io.cwd);
  let base: string;
  let head: string;
  try {
    [base, head] = await Promise.all([resolveRef(io.cwd, options.base), resolveRef(io.cwd, options.head!)]);
  } catch {
    io.stderr(`Couldn't resolve --base ${options.base} or --head ${options.head} to a commit.\n`);
    return 2;
  }

  // The gate config comes from the base branch, so a PR can't loosen the rules it is checked by.
  const configText = await git.readFile(base, GATE_CONFIG_FILE);
  let config: GateConfig = {};
  try {
    config = configText ? JSON.parse(configText) : {};
  } catch {
    io.stderr(`${GATE_CONFIG_FILE} on ${options.base} is not valid JSON.\n`);
    return 2;
  }

  const input: GateInput = {
    pr: { author: '', labels: [], branch: options.head!, base, head },
    commits: await readCommits(io.cwd, base, head),
    git,
    comments: [],
    config,
    bot: config.bot ?? DEFAULT_BOT,
    local: true,
  };
  const result = await runGate(input);

  if (options['run-summary']) {
    const summary = buildRunSummary(input, result, { generatedAt: new Date().toISOString() });
    writeFileSync(resolve(io.cwd, options['run-summary']), `${JSON.stringify(summary, null, 2)}\n`);
  }
  io.stdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderSummary(result));
  return result.status === 'pass' ? 0 : 1;
}
