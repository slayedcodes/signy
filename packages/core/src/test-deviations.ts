import ts from 'typescript';
import { beforeAfter, type Finding } from './finding.js';
import { extractTests, type Assertion, type TestBlock } from './test-blocks.js';
import type { ChangeContract } from './validate-contract.js';

type TestClause = NonNullable<ChangeContract['tests']>[number];

/** One file at the merge-base and at head; undefined where it doesn't exist. */
export interface FileVersions {
  path: string;
  before?: string;
  after?: string;
}

/** A test or describe block that is added, removed or modified, with any ways the change weakens it. */
interface TestChange {
  file: string;
  block: TestBlock;
  change: TestClause['change'];
  /** Why the change weakens the tests; empty when it doesn't. */
  weakenings: string[];
  before: string;
  after: string;
}

/** `file > name`, the way a test is named in Deviations. */
const testTarget = (file: string, name: string) => `${file} > ${name}`;

const SNAPSHOT_FILE = /^(.*?)__snapshots__\/([^/]+)\.snap$/;

export const isSnapshotFile = (path: string): boolean => SNAPSHOT_FILE.test(path);

/** The test file a Jest or Vitest snapshot file belongs to: `dir/__snapshots__/x.test.ts.snap` → `dir/x.test.ts`. */
export function snapshotTestFile(path: string): string {
  const [, dir, name] = SNAPSHOT_FILE.exec(path)!;
  return `${dir}${name}`;
}

/**
 * Test Weakening and tests Clauses. Weakening is deleting a test, removing an assertion,
 * adding `.skip`/`.only`/`.todo`, rewriting an existing snapshot or loosening a matcher; it
 * is an Unplanned Change unless a tests Clause covers it. `testFiles` must include the test
 * file of every snapshot file, changed or not, so snapshot entries can be tied to tests.
 */
export function testFindings(
  testFiles: FileVersions[],
  snapshotFiles: FileVersions[],
  clauses: TestClause[],
): { unplanned: Finding[]; unmet: Finding[] } {
  const unplanned: Finding[] = [];
  const changes: TestChange[] = [];
  const blocksByFile = new Map<string, TestBlock[]>();
  for (const file of testFiles) {
    const result = testFileChanges(file);
    if (result.unparsed) unplanned.push(result.unparsed);
    changes.push(...result.changes);
    blocksByFile.set(file.path, result.blocks);
  }
  for (const file of snapshotFiles) addSnapshotRewrites(file, changes, blocksByFile);

  const resolved = new Map(clauses.map((clause) => [clause, resolveClause(clause, blocksByFile.get(clause.file) ?? [])]));
  const covers = (clause: TestClause, c: TestChange) => {
    const { names } = resolved.get(clause)!;
    return (
      clause.file === c.file &&
      clause.change === c.change &&
      (names.has(c.block.name) || c.block.describes.some((d) => names.has(d)))
    );
  };

  for (const c of changes) {
    if (c.weakenings.length === 0 || clauses.some((clause) => covers(clause, c))) continue;
    const target = testTarget(c.file, c.block.name);
    unplanned.push({
      kind: 'unplanned-change',
      check: 'tests',
      target,
      detail:
        c.change === 'remove'
          ? `${target} is deleted, but no tests Clause declares removing it.`
          : `${target} is weakened: ${c.weakenings.join('; ')}. No tests Clause declares modifying it.`,
      content: `${c.change}\n${beforeAfter(c.before, c.after)}`,
    });
  }
  const unmet = clauses
    .filter((clause) => !changes.some((c) => covers(clause, c)))
    .map<Finding>((clause) => ({
      kind: 'unmet-clause',
      check: 'tests',
      target: testTarget(clause.file, clause.name),
      detail:
        `The Change Contract declares ${describeTestClause(clause)}, but the change doesn't.` +
        (resolved.get(clause)!.ambiguous ? ' The name matches more than one test; name it in full.' : ''),
      content: JSON.stringify(clause),
    }));
  return { unplanned, unmet };
}

/**
 * A Clause names a block by its full name, or by its own title when exactly one block has it;
 * naming a describe block covers everything inside it. An ambiguous title covers nothing.
 */
function resolveClause(clause: TestClause, blocks: TestBlock[]): { names: Set<string>; ambiguous: boolean } {
  if (blocks.some((b) => b.name === clause.name)) return { names: new Set([clause.name]), ambiguous: false };
  const byTitle = new Set(blocks.filter((b) => b.title === clause.name).map((b) => b.name));
  return byTitle.size > 1 ? { names: new Set(), ambiguous: true } : { names: byTitle, ambiguous: false };
}

function testFileChanges({ path, before, after }: FileVersions): { changes: TestChange[]; blocks: TestBlock[]; unparsed?: Finding } {
  const base = before === undefined ? undefined : extractTests(path, before);
  const head = after === undefined ? undefined : extractTests(path, after);
  if (base?.parseError || head?.parseError) {
    const blocks = [...(base?.parseError ? [] : (base?.blocks ?? [])), ...(head?.parseError ? [] : (head?.blocks ?? []))];
    if (!base?.blocks.length) return { changes: [], blocks };
    const unparsed: Finding = {
      kind: 'unplanned-change',
      check: 'tests',
      target: testTarget(path, '<unparsed>'),
      detail: `${path} can't be parsed, so the gate can't confirm that its tests aren't weakened.`,
      content: beforeAfter(before, after),
    };
    return { changes: [], blocks, unparsed };
  }
  const baseBlocks = new Map((base?.blocks ?? []).map((b) => [b.name, b]));
  const headBlocks = new Map((head?.blocks ?? []).map((b) => [b.name, b]));
  const changes: TestChange[] = [];
  for (const [name, block] of headBlocks) {
    const previous = baseBlocks.get(name);
    if (!previous) {
      // A new `.only` block silently skips every existing test.
      const weakenings = block.modifiers.includes('only') ? ['`.only` added'] : [];
      changes.push({ file: path, block, change: 'add', weakenings, before: '', after: block.text });
    } else if (previous.text !== block.text) {
      changes.push({
        file: path,
        block,
        change: 'modify',
        weakenings: weakenings(previous, block),
        before: previous.text,
        after: block.text,
      });
    }
  }
  for (const [name, block] of baseBlocks) {
    if (!headBlocks.has(name) && block.kind === 'test') {
      changes.push({ file: path, block, change: 'remove', weakenings: ['deleted'], before: block.text, after: '' });
    }
  }
  return { changes, blocks: [...baseBlocks.values(), ...[...headBlocks.values()].filter((b) => !baseBlocks.has(b.name))] };
}

function weakenings(before: TestBlock, after: TestBlock): string[] {
  const added = after.modifiers.filter((m) => !before.modifiers.includes(m)).map((m) => `\`.${m}\` added`);
  return [...added, ...assertionWeakenings(before.assertions, after.assertions)];
}

function assertionWeakenings(before: Assertion[], after: Assertion[]): string[] {
  const removed = [...before];
  const added: Assertion[] = [];
  for (const assertion of after) {
    const index = removed.findIndex((r) => r.text === assertion.text);
    if (index >= 0) removed.splice(index, 1);
    else added.push(assertion);
  }
  const found: string[] = [];
  for (const r of removed) {
    const loosened = added.findIndex((a) => a.subject === r.subject && loosens(r.matcher, a.matcher));
    if (loosened >= 0) {
      const [a] = added.splice(loosened, 1);
      found.push(`\`${r.matcher}\` loosened to \`${a!.matcher}\` in \`${a!.text}\``);
      continue;
    }
    // The same check on the same subject with other arguments is an edit, unless the arguments are gone.
    const edited = added.findIndex((a) => a.subject === r.subject && a.matcher === r.matcher);
    if (edited < 0) {
      found.push(`assertion \`${r.text}\` removed`);
      continue;
    }
    const [a] = added.splice(edited, 1);
    if (r.expected !== '' && a!.expected === '') found.push(`\`${r.matcher}\` loses its arguments in \`${a!.text}\``);
  }
  return found;
}

/** Matchers that only check that a value exists or is truthy. */
const VAGUE = ['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'not.toBeNull', 'not.toBeUndefined'];
const ANY_CALL = ['toHaveBeenCalled'];
/** The fixed list of loosened matchers: each matcher, and the looser ones that may replace it. */
const LOOSER: Record<string, string[]> = {
  toStrictEqual: ['toEqual', 'toMatchObject', ...VAGUE],
  toEqual: ['toMatchObject', ...VAGUE],
  toBe: ['toEqual', 'toMatchObject', ...VAGUE],
  toMatchObject: VAGUE,
  toHaveLength: VAGUE,
  toContain: VAGUE,
  toContainEqual: VAGUE,
  toMatch: VAGUE,
  toBeNull: ['toBeFalsy'],
  toBeUndefined: ['toBeFalsy'],
  toHaveBeenCalledWith: ANY_CALL,
  toHaveBeenCalledTimes: ANY_CALL,
  toHaveBeenCalledOnce: ANY_CALL,
  toHaveBeenLastCalledWith: ANY_CALL,
  toHaveBeenNthCalledWith: ANY_CALL,
  toHaveBeenCalledExactlyOnceWith: ANY_CALL,
};

/** `resolves.toEqual` → `resolves.toBeTruthy` loosens like `toEqual` → `toBeTruthy`; a negated matcher never does. */
function loosens(from: string, to: string): boolean {
  const split = (matcher: string) => {
    const match = /^((?:resolves\.|rejects\.)?)(.*)$/.exec(matcher)!;
    return [match[1]!, match[2]!] as const;
  };
  const [fromPrefix, fromMatcher] = split(from);
  const [toPrefix, toMatcher] = split(to);
  return fromPrefix === toPrefix && (LOOSER[fromMatcher] ?? []).includes(toMatcher);
}

/**
 * An existing snapshot entry that changes or goes rewrites its test's snapshot: it is
 * weakening of that test, and it modifies the test (so it can meet a modify Clause).
 * New entries only add.
 */
function addSnapshotRewrites({ path, before, after }: FileVersions, changes: TestChange[], blocksByFile: Map<string, TestBlock[]>) {
  if (before === undefined) return;
  const file = snapshotTestFile(path);
  const baseEntries = snapshotEntries(before);
  const headEntries = after === undefined ? new Map<string, string>() : snapshotEntries(after);
  for (const [key, value] of baseEntries) {
    if (headEntries.get(key) === value) continue;
    const name = key.replace(/ \d+$/, '');
    const content = { before: `\n\0snapshot ${key}\n${value}`, after: `\n\0snapshot ${key}\n${headEntries.get(key) ?? ''}` };
    const weakening = `snapshot \`${key}\` in ${path} ${headEntries.has(key) ? 'rewritten' : 'removed'}`;
    const existing = changes.find((c) => c.file === file && c.block.name === name);
    if (existing) {
      existing.weakenings.push(weakening);
      existing.before += content.before;
      existing.after += content.after;
      continue;
    }
    const block = blocksByFile.get(file)?.find((b) => b.name === name) ?? {
      kind: 'test',
      name,
      title: name,
      describes: [],
      modifiers: [],
      assertions: [],
      text: '',
    };
    changes.push({ file, block, change: 'modify', weakenings: [weakening], ...content });
  }
}

/** `exports[\`name 1\`] = …;` entries of a Jest or Vitest snapshot file. Anything unreadable is one opaque entry. */
function snapshotEntries(text: string): Map<string, string> {
  const source = ts.createSourceFile('x.snap.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const entries = new Map<string, string>();
  for (const statement of source.statements) {
    const expression = ts.isExpressionStatement(statement) ? statement.expression : undefined;
    if (
      expression &&
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(expression.left) &&
      ts.isStringLiteralLike(expression.left.argumentExpression)
    ) {
      entries.set(expression.left.argumentExpression.text, expression.right.getText(source));
    } else {
      entries.set('<unreadable>', `${entries.get('<unreadable>') ?? ''}${statement.getText(source)}\n`);
    }
  }
  return entries;
}

function describeTestClause(clause: TestClause): string {
  const target = testTarget(clause.file, clause.name);
  const verb = { add: 'adding', modify: 'changing', remove: 'removing' }[clause.change];
  return `${verb} the test ${target}`;
}
