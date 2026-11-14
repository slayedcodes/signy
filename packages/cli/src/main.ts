import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateContract } from '@change-contract/core';

export interface Io {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const CONTRACTS_DIR = '.contracts';

/** Runs the `contract` CLI and returns the process exit code. */
export async function main(args: string[], io: Io): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'validate') return validate(rest, io);
  io.stderr(`Unknown command: ${command ?? '(none)'}\nUsage: contract validate [file]\n`);
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
