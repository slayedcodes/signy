import { describe, expect, it } from 'vitest';
import { validateContract } from '../src/index.js';

/** The example Change Contract from PLAN.md §4. */
function exampleContract(): Record<string, any> {
  return {
    $schema: 'https://unpkg.com/@change-contract/core/schema/change-contract.schema.json',
    version: 1,
    slug: 'add-retry-to-billing-client',
    issue: 'https://example.com/issues/42',
    summary: 'Billing calls fail on transient 503s; retry them.',
    scope: {
      files: ['src/billing/client.ts', 'src/billing/retry.ts'],
      symbols: ['src/billing/client.ts#BillingClient.charge', 'src/billing/retry.ts#withRetry'],
    },
    interface: [
      {
        symbol: 'src/billing/retry.ts#withRetry',
        change: 'add',
        signature: 'withRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T>',
      },
    ],
    dependencies: [{ name: 'p-retry', change: 'add', range: '^6' }],
    tests: [{ file: 'src/billing/retry.test.ts', name: 'retries 3 times on 503', change: 'add' }],
    mustNotChange: ['src/billing/ledger/**', 'src/api/public.ts#*'],
    forks: [
      {
        id: 'F1',
        question: 'Retry on 429?',
        options: ['yes', 'no'],
        chosen: 'no',
        rationale: 'Upstream rate limits are enforced per hour.',
      },
    ],
  };
}

describe('validateContract', () => {
  it('accepts the example Change Contract', () => {
    expect(validateContract(exampleContract())).toEqual({ ok: true, errors: [] });
  });

  it('reports schema failures with the path of the offending value', () => {
    const contract = exampleContract();
    contract.dependencies[0].change = 'upgrade';

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ rule: 'schema', path: '/dependencies/0/change' }),
    );
  });

  it('rejects a scope glob wider than one directory level', () => {
    const contract = exampleContract();
    contract.scope.files.push('src/**');

    expect(validateContract(contract)).toEqual({
      ok: false,
      errors: [
        {
          rule: 'scope-glob-too-wide',
          path: '/scope/files/2',
          message: '"src/**" matches more than one directory level; list the files or use a single-level glob such as "src/billing/*".',
        },
      ],
    });
  });

  it('rejects an empty scope', () => {
    const contract = exampleContract();
    contract.scope = { files: [], symbols: [] };
    contract.interface = [];

    expect(validateContract(contract)).toEqual({
      ok: false,
      errors: [
        {
          rule: 'scope-empty',
          path: '/scope/files',
          message: 'The scope lists no files; a Change Contract must name at least one file it will change.',
        },
      ],
    });
  });

  it('rejects a symbol listed twice in the scope', () => {
    const contract = exampleContract();
    contract.scope.symbols.push('src/billing/retry.ts#withRetry');

    expect(validateContract(contract)).toEqual({
      ok: false,
      errors: [
        {
          rule: 'duplicate-symbol',
          path: '/scope/symbols/2',
          message: '"src/billing/retry.ts#withRetry" is already listed at /scope/symbols/1.',
        },
      ],
    });
  });

  it('rejects a slug that does not match the file name, when the file is known', () => {
    const contract = exampleContract();

    expect(validateContract(contract, { file: '.contracts/add-retry-to-billing-client.json' }).ok).toBe(true);
    expect(validateContract(contract, { file: '.contracts/retry.json' })).toEqual({
      ok: false,
      errors: [
        {
          rule: 'slug-matches-file',
          path: '/slug',
          message: 'slug "add-retry-to-billing-client" must match the file name; expected "retry".',
        },
      ],
    });
  });

  it('rejects two interface Clauses for the same symbol', () => {
    const contract = exampleContract();
    contract.interface.push({ symbol: 'src/billing/retry.ts#withRetry', change: 'modify' });

    expect(validateContract(contract)).toEqual({
      ok: false,
      errors: [
        {
          rule: 'duplicate-symbol',
          path: '/interface/1/symbol',
          message: '"src/billing/retry.ts#withRetry" is already listed at /interface/0/symbol.',
        },
      ],
    });
  });
});
