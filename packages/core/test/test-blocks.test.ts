import { describe, expect, it } from 'vitest';
import { extractTests } from '../src/test-blocks.js';

const blocks = (text: string) => extractTests('src/x.test.ts', text).blocks;
const block = (text: string, name: string) => blocks(text).find((b) => b.name === name);

describe('extractTests', () => {
  it('reads a test with its assertions', () => {
    const text = [
      "import { expect, it } from 'vitest';",
      "it('adds numbers', () => {",
      '  expect(add(1, 2)).toBe(3);',
      '});',
    ].join('\n');

    expect(blocks(text)).toEqual([
      {
        kind: 'test',
        name: 'adds numbers',
        title: 'adds numbers',
        describes: [],
        modifiers: [],
        assertions: [{ subject: 'add(1, 2)', matcher: 'toBe', expected: '3', text: 'expect(add(1, 2)).toBe(3)' }],
        text: "it('adds numbers', () => {\n  expect(add(1, 2)).toBe(3);\n})",
      },
    ]);
  });

  it('names nested tests by their describe titles, as Jest and Vitest do', () => {
    const text = [
      "describe('BillingClient', () => {",
      "  describe('charge', () => {",
      '    it(`retries 3 times on 503`, async () => {});',
      '  });',
      "  test('refunds', () => {});",
      '});',
    ].join('\n');

    expect(blocks(text).map((b) => [b.kind, b.name, b.title])).toEqual([
      ['describe', 'BillingClient', 'BillingClient'],
      ['describe', 'BillingClient charge', 'charge'],
      ['test', 'BillingClient charge retries 3 times on 503', 'retries 3 times on 503'],
      ['test', 'BillingClient refunds', 'refunds'],
    ]);
  });

  it('reads skip, only and todo modifiers in every spelling', () => {
    const text = [
      "describe.skip('suite', () => {",
      "  it.only('a', () => {});",
      "  test.todo('b');",
      "  xit('c', () => {});",
      "  fit('d', () => {});",
      "  it.skipIf(process.env.CI)('e', () => {});",
      "  test.concurrent.skip('f', () => {});",
      "  it.each([1, 2])('g %i', (n) => { expect(n).toBeGreaterThan(0); });",
      '});',
      "xdescribe('other', () => {});",
    ].join('\n');

    expect(blocks(text).map((b) => [b.name, b.modifiers])).toEqual([
      ['suite', ['skip']],
      ['suite a', ['only']],
      ['suite b', ['todo']],
      ['suite c', ['skip']],
      ['suite d', ['only']],
      ['suite e', ['skip']],
      ['suite f', ['skip']],
      ['suite g %i', []],
      ['other', ['skip']],
    ]);
    expect(block(text, 'suite g %i')?.assertions).toHaveLength(1);
  });

  it('reads negated, async, soft and assert-style assertions', () => {
    const text = [
      "it('a', async () => {",
      '  expect.assertions(4);',
      '  expect(x).not.toBeNull();',
      '  await expect(load()).resolves.toEqual({ ok: true });',
      '  expect.soft(y).toBe(2);',
      '  assert.equal(z, 3);',
      '  assert(w);',
      '});',
    ].join('\n');

    expect(block(text, 'a')?.assertions.map((a) => [a.subject, a.matcher])).toEqual([
      ['', 'expect.assertions'],
      ['x', 'not.toBeNull'],
      ['load()', 'resolves.toEqual'],
      ['y', 'toBe'],
      ['z, 3', 'assert.equal'],
      ['w', 'assert'],
    ]);
  });

  it('keeps tests that share a name apart', () => {
    const text = "it('same', () => { expect(1).toBe(1); });\nit('same', () => { expect(2).toBe(2); });\n";

    expect(blocks(text).map((b) => [b.name, b.title])).toEqual([
      ['same', 'same'],
      ['same [2]', 'same'],
    ]);
  });

  it('records the enclosing describe blocks, including Vitest suite()', () => {
    const text = "suite('s', () => {\n  describe('d', () => {\n    test('a', () => {});\n  });\n});\n";

    expect(blocks(text).map((b) => [b.name, b.describes])).toEqual([
      ['s', []],
      ['s d', ['s']],
      ['s d a', ['s', 's d']],
    ]);
  });

  it('reads the test function after a Vitest options argument', () => {
    const text = "it('a', { timeout: 100 }, () => {\n  expect(f()).toBe(1);\n});\n";

    expect(block(text, 'a')?.assertions.map((a) => a.text)).toEqual(['expect(f()).toBe(1)']);
  });

  it('reports a file that does not parse', () => {
    expect(extractTests('src/x.test.ts', "it('a', () => {\n").parseError).toBe(true);
    expect(extractTests('src/x.test.ts', "it('a', () => {});\n").parseError).toBe(false);
  });
});
