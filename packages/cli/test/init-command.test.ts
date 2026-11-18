import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';

const bin = fileURLToPath(new URL('../bin/contract.js', import.meta.url));

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'contract-init-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function contract(...args: string[]) {
  const run = spawnSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const read = (path: string) => JSON.parse(readFileSync(join(repo, path), 'utf8'));

describe('contract init', () => {
  it('scaffolds .contracts/<slug>.json from an issue described in text', () => {
    const run = contract('init', '--issue', 'Billing calls fail on transient 503s; retry them.', '--scope', 'src/billing/retry.ts');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(read('.contracts/billing-calls-fail-on-transient-503s.json')).toEqual({
      $schema: 'https://raw.githubusercontent.com/slayedcodes/signy/main/schema/change-contract.schema.json',
      version: 1,
      slug: 'billing-calls-fail-on-transient-503s',
      issue: 'Billing calls fail on transient 503s; retry them.',
      summary: 'Billing calls fail on transient 503s; retry them.',
      scope: { files: ['src/billing/retry.ts'], symbols: [] },
      interface: [],
      dependencies: [],
      tests: [],
      mustNotChange: [],
      forks: [],
    });
    expect(run.stdout).toBe(
      [
        'Wrote .contracts/billing-calls-fail-on-transient-503s.json.',
        'Next: fill in the scope and the Clauses, run `contract validate`, then commit the Change Contract on its own as the first commit of the PR.',
        '',
      ].join('\n'),
    );
  });

  it('keeps an issue URL as a link, and takes the slug and summary from flags', () => {
    const run = contract('init', '--issue', 'https://github.com/acme/pilot/issues/12', '--slug', 'add-retry', '--summary', 'Retry 503s.');

    expect(run.status).toBe(0);
    expect(read('.contracts/add-retry.json')).toMatchObject({
      slug: 'add-retry',
      issue: 'https://github.com/acme/pilot/issues/12',
      summary: 'Retry 503s.',
      scope: { files: [], symbols: [] },
    });
  });

  it("names what's missing when there is no terminal to ask on", () => {
    const run = contract('init', '--issue', 'https://github.com/acme/pilot/issues/12');

    expect(run.status).toBe(2);
    expect(run.stderr).toBe('Missing --summary and --slug, and there is no terminal to ask for them on.\n');
    expect(existsSync(join(repo, '.contracts'))).toBe(false);
  });

  it.for([
    ['--slug', '../escape', "--slug ../escape isn't a slug: use lowercase words joined by hyphens, like add-retry."],
    ['--slug', 'Bad Slug', "--slug Bad Slug isn't a slug: use lowercase words joined by hyphens, like add-retry."],
  ])('refuses %s %s', ([flag, value, message]) => {
    const run = contract('init', '--issue', 'Retry 503s.', flag!, value!);

    expect(run.status).toBe(2);
    expect(run.stderr).toBe(`${message}\n`);
    expect(existsSync(join(repo, '.contracts'))).toBe(false);
  });

  it('asks for a slug when the text has no words to make one from, and an empty summary counts as missing', () => {
    expect(contract('init', '--issue', '!!!').stderr).toBe('Missing --slug, and there is no terminal to ask for it on.\n');
    expect(contract('init', '--issue', 'https://x.example/1', '--summary', '', '--slug', 'a').stderr).toBe(
      'Missing --summary, and there is no terminal to ask for it on.\n',
    );
  });

  it('never overwrites an existing Change Contract', () => {
    mkdirSync(join(repo, '.contracts'));
    writeFileSync(join(repo, '.contracts', 'add-retry.json'), '{}');

    const run = contract('init', '--issue', 'Retry 503s.', '--slug', 'add-retry');

    expect(run.status).toBe(1);
    expect(run.stderr).toBe('.contracts/add-retry.json already exists. Choose another slug for a new Change Contract.\n');
    expect(readFileSync(join(repo, '.contracts', 'add-retry.json'), 'utf8')).toBe('{}');
  });

  it('asks for anything missing when a terminal is attached', async () => {
    const questions: string[] = [];
    const answers = ['Retry transient 503s in the billing client.', ''];
    const out: string[] = [];

    const status = await main(['init', '--issue', 'https://github.com/acme/pilot/issues/12'], {
      cwd: repo,
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      prompt: async (question) => {
        questions.push(question);
        return answers.shift()!;
      },
    });

    expect(status).toBe(0);
    expect(questions).toEqual([
      'Summary (why this change exists, in one paragraph): ',
      'Slug [retry-transient-503s-in-the-billing]: ',
    ]);
    expect(read('.contracts/retry-transient-503s-in-the-billing.json')).toMatchObject({
      summary: 'Retry transient 503s in the billing client.',
    });
  });
});
