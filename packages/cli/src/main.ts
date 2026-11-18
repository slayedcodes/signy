import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateContract } from '@change-contract/core';
import type { Fetch } from '@change-contract/adapter-github';
import { approve } from './approve.js';
import { feedback } from './feedback.js';
import { check } from './check.js';
import { init } from './init.js';

export interface Io {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Asks a question on the terminal; absent when there is no terminal to ask on. */
  prompt?: (question: string) => Promise<string>;
  /** Environment variables (GITHUB_TOKEN, GH_TOKEN, GITHUB_API_URL). */
  env?: Record<string, string | undefined>;
  /** HTTP for the GitHub commands; tests replay recorded responses. */
  fetch?: Fetch;
  /** `gh auth token`, the token fallback; tests replace it. */
  ghToken?: () => Promise<string | undefined>;
}

const CONTRACTS_DIR = '.contracts';

/** Runs the `contract` CLI and returns the process exit code. */
export async function main(args: string[], io: Io): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'validate') return validate(rest, io);
  if (command === 'check') return check(rest, io);
  if (command === 'init') return init(rest, io);
  if (command === 'approve') return approve(rest, io);
  if (command === 'feedback') return feedback(rest, io);
  io.stderr(`Unknown command: ${command ?? '(none)'}\nUsage: contract init | validate | check | approve | feedback\n`);
  return 2;
}

function validate(args: string[], io: Io): number {
  const files = args.length > 0 ? args : findContracts(io.cwd);
  if (files.length === 0) {
    io.stderr(`No Change Contract found in ${CONTRACTS_DIR}/. Run \`contract init\` to create one.\n`);
    return 1;
  }
  const results = files.map((file) => validateFile(file, io));
  return results.every(Boolean) ? 0 : 1;
}

function findContracts(cwd: string): string[] {
  const dir = resolve(cwd, CONTRACTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${CONTRACTS_DIR}/${name}`);
}

function validateFile(file: string, io: Io): boolean {
  const fullPath = resolve(io.cwd, file);
  if (!existsSync(fullPath)) {
    io.stderr(`${file}: file not found\n`);
    return false;
  }
  let contract: unknown;
  try {
    contract = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    io.stderr(`${file}: not valid JSON (${(error as Error).message})\n`);
    return false;
  }
  const result = validateContract(contract, { file });
  if (result.ok) {
    io.stdout(`${file}: valid Change Contract\n`);
    return true;
  }
  const lines = result.errors.map((e) => `  ${e.path || '/'} [${e.rule}] ${e.message}`);
  io.stderr([`${file}: invalid Change Contract`, ...lines, ''].join('\n'));
  return false;
}
