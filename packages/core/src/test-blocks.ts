import ts from 'typescript';

/** One `expect(subject).matcher(...)` call inside a test. */
export interface Assertion {
  subject: string;
  matcher: string;
  /** The matcher's arguments: what the subject is checked against. */
  expected: string;
  text: string;
}

/** A `describe` block or a test (`it`/`test`) in a test file. */
export interface TestBlock {
  kind: 'describe' | 'test';
  /** The enclosing describe titles and the block's own title, joined by spaces, as Jest and Vitest name tests. */
  name: string;
  title: string;
  /** The names of the enclosing describe blocks, outermost first. */
  describes: string[];
  modifiers: string[];
  /** The assertions in a test's own body. */
  assertions: Assertion[];
  text: string;
}

export interface ExtractedTests {
  blocks: TestBlock[];
  parseError: boolean;
}

/** The functions that open a block, with the modifier their prefixed spelling implies (`xit`, `fdescribe`, …). */
const BLOCK_FUNCTIONS: Record<string, { kind: TestBlock['kind']; modifier?: string }> = {
  describe: { kind: 'describe' },
  suite: { kind: 'describe' },
  xdescribe: { kind: 'describe', modifier: 'skip' },
  fdescribe: { kind: 'describe', modifier: 'only' },
  it: { kind: 'test' },
  test: { kind: 'test' },
  xit: { kind: 'test', modifier: 'skip' },
  xtest: { kind: 'test', modifier: 'skip' },
  fit: { kind: 'test', modifier: 'only' },
};

/** Chained names a block function may carry. Those that change whether the block runs map to a modifier. */
const CHAINED_MODIFIERS: Record<string, string | undefined> = {
  skip: 'skip',
  skipIf: 'skip',
  runIf: 'skip',
  only: 'only',
  todo: 'todo',
  each: undefined,
  concurrent: undefined,
  sequential: undefined,
  fails: undefined,
  shuffle: undefined,
};

/**
 * Recognizes `it`, `describe.skip`, `test.concurrent.only`, `it.skipIf(cond)`, `it.each(table)`
 * and the like. Returns undefined for any other callee.
 */
function testCallee(expression: ts.Expression): { kind: TestBlock['kind']; modifiers: string[] } | undefined {
  const chained: string[] = [];
  let node = expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      chained.unshift(node.name.text);
      node = node.expression;
    } else if (ts.isCallExpression(node)) {
      node = node.expression;
    } else break;
  }
  if (!ts.isIdentifier(node) || !Object.hasOwn(BLOCK_FUNCTIONS, node.text)) return undefined;
  if (!chained.every((name) => Object.hasOwn(CHAINED_MODIFIERS, name))) return undefined;
  const root = BLOCK_FUNCTIONS[node.text]!;
  const modifiers = [root.modifier, ...chained.map((name) => CHAINED_MODIFIERS[name])].filter((m): m is string => m !== undefined);
  return { kind: root.kind, modifiers: [...new Set(modifiers)] };
}

/** Reads the describe blocks, tests and assertions of one test file, without running it. */
export function extractTests(path: string, text: string): ExtractedTests {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const blocks: TestBlock[] = [];
  const counts = new Map<string, number>();
  /** `titles`: the enclosing describe titles; `describes`: those blocks' names. */
  const visit = (node: ts.Node, titles: string[], describes: string[]) => {
    if (ts.isCallExpression(node)) {
      const callee = testCallee(node.expression);
      if (callee) {
        const { kind, modifiers } = callee;
        const title = titleOf(node.arguments[0], source);
        const fullName = [...titles, title].join(' ');
        const seen = (counts.get(fullName) ?? 0) + 1;
        counts.set(fullName, seen);
        // A repeated name gets its position, so each block keeps an identity of its own.
        const name = seen === 1 ? fullName : `${fullName} [${seen}]`;
        // The test function is the last function argument; Vitest allows an options object before it.
        const body = node.arguments.slice(1).filter((arg) => ts.isFunctionLike(arg)).at(-1);
        blocks.push({
          kind,
          name,
          title,
          describes,
          modifiers,
          assertions: kind === 'test' ? assertionsIn(body, source) : [],
          text: node.getText(source),
        });
        if (kind === 'describe') node.arguments.slice(1).forEach((arg) => visit(arg, [...titles, title], [...describes, name]));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, titles, describes));
  };
  visit(source, [], []);
  const parseError = (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0;
  return { blocks, parseError };
}

function titleOf(node: ts.Expression | undefined, source: ts.SourceFile): string {
  if (!node) return '';
  if (ts.isStringLiteralLike(node)) return node.text;
  return node.getText(source);
}

function assertionsIn(body: ts.Node | undefined, source: ts.SourceFile): Assertion[] {
  const assertions: Assertion[] = [];
  const visit = (node: ts.Node) => {
    const assertion = ts.isCallExpression(node) ? readAssertion(node, source) : undefined;
    if (assertion) assertions.push(assertion);
    else ts.forEachChild(node, visit);
  };
  if (body) visit(body);
  return assertions;
}

const argumentsText = (call: ts.CallExpression, source: ts.SourceFile) => call.arguments.map((a) => a.getText(source)).join(', ');

/**
 * `expect(x).matcher(…)` with any chain in between (`not`, `resolves`, …), `expect.soft(x)…`,
 * `expect.assertions(n)`, `expect.hasAssertions()`, and `assert(…)` / `assert.method(…)`.
 */
function readAssertion(call: ts.CallExpression, source: ts.SourceFile): Assertion | undefined {
  const chain: string[] = [];
  let base = call.expression;
  while (ts.isPropertyAccessExpression(base)) {
    chain.unshift(base.name.text);
    base = base.expression;
  }
  const text = call.getText(source);
  if (ts.isCallExpression(base) && chain.length > 0 && isExpect(base.expression)) {
    return { subject: argumentsText(base, source), matcher: chain.join('.'), expected: argumentsText(call, source), text };
  }
  if (ts.isIdentifier(base) && base.text === 'expect' && ['assertions', 'hasAssertions'].includes(chain[0] ?? '')) {
    return { subject: '', matcher: `expect.${chain.join('.')}`, expected: argumentsText(call, source), text };
  }
  if (ts.isIdentifier(base) && base.text === 'assert') {
    return { subject: argumentsText(call, source), matcher: ['assert', ...chain].join('.'), expected: '', text };
  }
  return undefined;
}

/** `expect`, `expect.soft` or `expect.poll`. */
function isExpect(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'expect';
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'expect' &&
    ['soft', 'poll'].includes(node.name.text)
  );
}
