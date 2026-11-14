import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../bin/contract.js', import.meta.url));

const validContract = {
  version: 1,
  slug: 'add-retry-to-billing-client',
  summary: 'Billing calls fail on transient 503s; retry them.',
  scope: { files: ['src/billing/retry.ts'], symbols: ['src/billing/retry.ts#withRetry'] },
};

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'contract-cli-'));
  mkdirSync(join(repo, '.contracts'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeContract(name: string, contract: unknown): void {
  writeFileSync(join(repo, '.contracts', name), JSON.stringify(contract, null, 2));
}

function contract(...args: string[]) {
  const run = spawnSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('contract validate', () => {
  it('exits 0 for a valid Change Contract', () => {
    writeContract('add-retry-to-billing-client.json', validContract);

    const run = contract('validate', '.contracts/add-retry-to-billing-client.json');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('.contracts/add-retry-to-billing-client.json: valid Change Contract\n');
  });

  it('exits 1 and names each failed rule for an invalid Change Contract', () => {
    writeContract('too-wide.json', {
      ...validContract,
      slug: 'too-wide',
      scope: { files: ['src/**'], symbols: ['a.ts#x', 'a.ts#x'] },
    });

    const run = contract('validate', '.contracts/too-wide.json');

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(
      [
        '.contracts/too-wide.json: invalid Change Contract',
        '  /scope/files/0 [scope-glob-too-wide] "src/**" matches more than one directory level; list the files or use a single-level glob such as "src/billing/*".',
        '  /scope/symbols/1 [duplicate-symbol] "a.ts#x" is already listed at /scope/symbols/0.',
        '',
      ].join('\n'),
    );
  });

  it('exits 1 when the slug does not match the file name', () => {
    writeContract('retry.json', validContract);

    const run = contract('validate', '.contracts/retry.json');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      '  /slug [slug-matches-file] slug "add-retry-to-billing-client" must match the file name; expected "retry".\n',
    );
  });

  it('exits 1 when the file is not valid JSON', () => {
    writeFileSync(join(repo, '.contracts', 'broken.json'), '{ "version": 1,');

    const run = contract('validate', '.contracts/broken.json');

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^\.contracts\/broken\.json: not valid JSON \(.+\)\n$/);
  });

  it('exits 1 when the file does not exist', () => {
    const run = contract('validate', '.contracts/missing.json');

    expect(run.status).toBe(1);
    expect(run.stderr).toBe('.contracts/missing.json: file not found\n');
  });

  it('validates every contract in .contracts/ when no file is given', () => {
    writeContract('b-second.json', { ...validContract, slug: 'b-second' });
    writeContract('a-first.json', { ...validContract, slug: 'a-first', scope: { files: [], symbols: [] } });

    const run = contract('validate');

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('.contracts/b-second.json: valid Change Contract\n');
    expect(run.stderr).toContain('.contracts/a-first.json: invalid Change Contract\n');
  });

  it('points to `contract init` when there is no contract to validate', () => {
    const run = contract('validate');

    expect(run.status).toBe(1);
    expect(run.stderr).toBe('No Change Contract found in .contracts/. Run `contract init` to create one.\n');
  });
});
