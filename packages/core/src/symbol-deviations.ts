import type { Finding } from './finding.js';
import { matchesGlob } from './glob.js';
import { extractSymbols, normalizeSignature, type ExtractedSymbols, type SourceSymbol } from './symbols.js';
import type { FileChange } from './types.js';
import type { ChangeContract } from './validate-contract.js';

type InterfaceClause = NonNullable<ChangeContract['interface']>[number];

/** One change to a module's public interface: a symbol's exported signature appears, goes or changes. */
export interface InterfaceChange {
  /** `path#Name`, as interface Clauses name it. */
  symbol: string;
  change: 'add' | 'remove' | 'modify';
  before?: string;
  after?: string;
  /** The whole file is already an Unplanned Change, so this needs no Deviation of its own. */
  coveredByFile?: boolean;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const NO_SYMBOLS: ExtractedSymbols = { symbols: [], topLevel: '', parseError: false };

/** Symbol-level checks need a TypeScript or JavaScript source the compiler API can read. */
export const isSourceFile = (path: string): boolean => SOURCE_FILE.test(path);

/**
 * A file the gate can't read symbols from (JSON, Markdown, …) can't prove that a listed
 * symbol is the only thing that changed, so it fails safe: a `path#Name` must-not-change
 * entry, or symbols listed in its scope, make any change to it unplanned.
 */
export function nonSourceFindings(change: FileChange, contract: ChangeContract, inScope: boolean, content: string): Finding[] {
  const { path } = change;
  const protectedSymbol = (contract.mustNotChange ?? []).find((entry) => {
    const [glob, name] = entry.split('#');
    return name !== undefined && name !== '*' && matchesGlob(path, glob!);
  });
  const why = "It isn't TypeScript or JavaScript, so the gate can't";
  if (protectedSymbol) {
    return [{
      kind: 'unplanned-change',
      check: 'must-not-change',
      target: protectedSymbol,
      detail: `${path} is ${change.status}. ${why} confirm that ${protectedSymbol} stayed unchanged.`,
      content,
    }];
  }
  if (inScope && contract.scope.symbols.some((s) => s.startsWith(`${path}#`))) {
    return [{
      kind: 'unplanned-change',
      check: 'scope',
      target: `${path}#<not-source>`,
      detail: `${path} is ${change.status}. ${why} tie the change to the symbols its scope lists.`,
      content,
    }];
  }
  return [];
}

/**
 * Compares one file's symbols before and after the change. Must-not-change symbol entries
 * apply to every file; symbol scope applies only to an in-scope file whose scope lists symbols
 * (a file with none listed is in scope as a whole). Anything the gate can't tie to a symbol,
 * such as top-level code or a file that won't parse, counts as unplanned.
 */
export function symbolFindings(
  change: FileChange,
  before: string | undefined,
  after: string | undefined,
  contract: ChangeContract,
  inScope: boolean,
): { findings: Finding[]; interfaceChanges: InterfaceChange[] } {
  const { path } = change;
  const old = before === undefined ? NO_SYMBOLS : extractSymbols(path, before);
  const now = after === undefined ? NO_SYMBOLS : extractSymbols(path, after);
  const listed = contract.scope.symbols.filter((s) => s.startsWith(`${path}#`)).map((s) => s.slice(path.length + 1));
  const symbolScoped = inScope && listed.length > 0;
  const protectedSymbols = (contract.mustNotChange ?? [])
    .map((entry) => entry.split('#') as [string, string | undefined])
    .filter(([glob, name]) => name !== undefined && name !== '*' && matchesGlob(path, glob))
    .map(([, name]) => name!);
  const covers = (names: string[], name: string) => names.some((n) => name === n || name.startsWith(`${n}.`));

  if (old.parseError || now.parseError) {
    if (!symbolScoped && protectedSymbols.length === 0) return { findings: [], interfaceChanges: [] };
    const check = protectedSymbols.length > 0 ? 'must-not-change' : 'scope';
    const why =
      check === 'must-not-change'
        ? `so the gate can't confirm that ${protectedSymbols.map((n) => `${path}#${n}`).join(', ')} stayed unchanged.`
        : 'so its changes can\'t be tied to symbols, and the scope lists symbols for this file.';
    const finding: Finding = {
      kind: 'unplanned-change',
      check,
      target: `${path}#<unparsed>`,
      detail: `${path} can't be parsed, ${why}`,
      content: `${before ?? ''}\n\0\n${after ?? ''}`,
    };
    return { findings: [finding], interfaceChanges: [] };
  }

  const findings: Finding[] = [];
  for (const { name, status, was, is } of changedSymbols(old.symbols, now.symbols)) {
    const target = `${path}#${name}`;
    const content = `${was?.text ?? ''}\n\0\n${is?.text ?? ''}`;
    const protectedBy = protectedSymbols.find((n) => covers([n], name));
    if (protectedBy !== undefined) {
      const detail = `${target} is ${status}, but the Change Contract says ${path}#${protectedBy} must not change.`;
      findings.push({ kind: 'unplanned-change', check: 'must-not-change', target, detail, content });
    } else if (symbolScoped && !covers(listed, name)) {
      const detail = `${target} is ${status}, but no scope Clause covers it.`;
      findings.push({ kind: 'unplanned-change', check: 'scope', target, detail, content });
    }
  }
  if (symbolScoped && old.topLevel !== now.topLevel) {
    findings.push({
      kind: 'unplanned-change',
      check: 'scope',
      target: `${path}#<top-level>`,
      detail: `Top-level code in ${path} changes. The gate can't tie it to a symbol, and the scope lists symbols for this file.`,
      content: `${old.topLevel}\n\0\n${now.topLevel}`,
    });
  }
  return { findings, interfaceChanges: interfaceChanges(path, old.symbols, now.symbols) };
}

function changedSymbols(before: SourceSymbol[], after: SourceSymbol[]) {
  const was = new Map(before.map((s) => [s.name, s]));
  const is = new Map(after.map((s) => [s.name, s]));
  const changes: Array<{ name: string; status: string; was?: SourceSymbol; is?: SourceSymbol }> = [];
  for (const [name, symbol] of is) {
    const previous = was.get(name);
    if (!previous) changes.push({ name, status: 'added', is: symbol });
    else if (previous.text !== symbol.text) changes.push({ name, status: 'modified', was: previous, is: symbol });
  }
  for (const [name, symbol] of was) if (!is.has(name)) changes.push({ name, status: 'removed', was: symbol });
  return changes;
}

function interfaceChanges(path: string, before: SourceSymbol[], after: SourceSymbol[]): InterfaceChange[] {
  const signatures = (symbols: SourceSymbol[]) =>
    new Map(symbols.filter((s) => s.exported && s.signature !== undefined).map((s) => [s.name, s.signature!]));
  const [was, is] = [signatures(before), signatures(after)];
  const changes: InterfaceChange[] = [];
  for (const [name, signature] of is) {
    const previous = was.get(name);
    if (previous === undefined) changes.push({ symbol: `${path}#${name}`, change: 'add', after: signature });
    else if (previous !== signature) changes.push({ symbol: `${path}#${name}`, change: 'modify', before: previous, after: signature });
  }
  for (const [name, signature] of was) {
    if (!is.has(name)) changes.push({ symbol: `${path}#${name}`, change: 'remove', before: signature });
  }
  return changes;
}

/** A Clause's signature in the same normal form the extractor produces. */
export function clauseSignature(signature: string): string {
  return normalizeSignature(signature.replace(/^(?:(?:export|declare|function)\s+)+/, ''));
}

/**
 * The form two signatures are compared in: modifier keywords dropped, and a member's
 * `Class.` prefix dropped, so `charge(...)`, `Client.charge(...)` and `async charge(...)`
 * all name the same thing. The interface diff itself still compares full signatures.
 */
function canonicalSignature(signature: string, symbol: string): string {
  const qualified = symbol.slice(symbol.indexOf('#') + 1);
  const withoutKeywords = normalizeSignature(signature).replace(
    /^(?:(?:export|declare|default|static|async|function|public|override|abstract|readonly) )+/,
    '',
  );
  const member = qualified.slice(qualified.lastIndexOf('.') + 1);
  return qualified.includes('.') && withoutKeywords.startsWith(qualified)
    ? member + withoutKeywords.slice(qualified.length)
    : withoutKeywords;
}

/** A Clause allows a change when symbol and kind match, and its signature (if given) is the new one. */
export function interfaceClauseAllows(clause: InterfaceClause, change: InterfaceChange): boolean {
  if (clause.symbol !== change.symbol || clause.change !== change.change) return false;
  if (clause.signature === undefined || change.change === 'remove') return true;
  return canonicalSignature(clause.signature, clause.symbol) === canonicalSignature(change.after!, change.symbol);
}

export function interfaceFindings(clauses: InterfaceClause[], changes: InterfaceChange[]): { unplanned: Finding[]; unmet: Finding[] } {
  const unplanned = changes
    .filter((c) => !c.coveredByFile && !clauses.some((clause) => interfaceClauseAllows(clause, c)))
    .map<Finding>((c) => ({
      kind: 'unplanned-change',
      check: 'interface',
      target: c.symbol,
      detail: `${describeInterfaceChange(c)}, but no interface Clause declares it.`,
      content: `${c.change}\n${c.before ?? ''}\n\0\n${c.after ?? ''}`,
    }));
  const unmet = clauses
    .filter((clause) => !changes.some((c) => interfaceClauseAllows(clause, c)))
    .map<Finding>((clause) => {
      const actual = changes.find((c) => c.symbol === clause.symbol && c.change === clause.change);
      return {
        kind: 'unmet-clause',
        check: 'interface',
        target: clause.symbol,
        detail: actual
          ? `The Change Contract declares ${clause.symbol} with the signature ${clauseSignature(clause.signature!)}, but the change gives it ${actual.after}.`
          : `The Change Contract declares ${describeInterfaceClause(clause)}, but the change doesn't.`,
        content: `${JSON.stringify(clause)}\n${actual?.after ?? ''}`,
      };
    });
  return { unplanned, unmet };
}

function describeInterfaceChange(c: InterfaceChange): string {
  if (c.change === 'add') return `The public interface gains ${c.symbol} (${c.after})`;
  if (c.change === 'remove') return `The public interface loses ${c.symbol}`;
  return `The signature of ${c.symbol} changes from ${c.before} to ${c.after}`;
}

function describeInterfaceClause(clause: InterfaceClause): string {
  if (clause.change === 'add') return `adding ${clause.symbol} to the interface`;
  if (clause.change === 'remove') return `removing ${clause.symbol} from the interface`;
  return `changing the signature of ${clause.symbol}`;
}
