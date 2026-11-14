import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../src/symbols.js';

const names = (text: string) => extractSymbols('src/x.ts', text).symbols.map((s) => s.name);
const symbol = (text: string, name: string) => extractSymbols('src/x.ts', text).symbols.find((s) => s.name === name);

describe('extractSymbols', () => {
  it('reads an exported function with its signature', () => {
    const text = 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n';

    expect(extractSymbols('src/greet.ts', text).symbols).toEqual([
      {
        name: 'greet',
        exported: true,
        signature: 'greet(name:string):string',
        text: 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}',
      },
    ]);
  });

  const CLIENT = [
    'export class BillingClient<T> extends Base implements Client {',
    '  private retries = 3;',
    '  constructor(private readonly http: Http) { super(); }',
    '  charge(amount: number): Promise<void> { return this.http.post(amount); }',
    '  static create(): BillingClient<never> { return new BillingClient(http); }',
    '  #secret(): void {}',
    '}',
  ].join('\n');

  it('reads a class header and each member as Class.member', () => {
    expect(names(CLIENT)).toEqual([
      'BillingClient',
      'BillingClient.retries',
      'BillingClient.constructor',
      'BillingClient.charge',
      'BillingClient.create',
      'BillingClient.#secret',
    ]);
    expect(symbol(CLIENT, 'BillingClient')).toMatchObject({
      exported: true,
      signature: 'class BillingClient<T>extends Base implements Client',
      text: 'export class BillingClient<T> extends Base implements Client {',
    });
    expect(symbol(CLIENT, 'BillingClient.charge')?.signature).toBe('BillingClient.charge(amount:number):Promise<void>');
    expect(symbol(CLIENT, 'BillingClient.create')?.signature).toBe('static BillingClient.create():BillingClient<never>');
    expect(symbol(CLIENT, 'BillingClient.constructor')?.signature).toBe(
      'BillingClient.constructor(private readonly http:Http)',
    );
  });

  it('keeps private members out of the public interface', () => {
    expect(symbol(CLIENT, 'BillingClient.retries')).toMatchObject({ exported: false });
    expect(symbol(CLIENT, 'BillingClient.retries')).not.toHaveProperty('signature');
    expect(symbol(CLIENT, 'BillingClient.#secret')).toMatchObject({ exported: false });
  });

  it('reads an arrow-function const with a function signature', () => {
    const text = 'export const withRetry = async <T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> => fn();\n';

    expect(symbol(text, 'withRetry')?.signature).toBe('withRetry<T>(fn:()=>Promise<T>,opts?:RetryOpts):Promise<T>');
  });

  it('reads other variables by annotation, or by initializer when unannotated', () => {
    const text = 'export const LIMIT: number = 3;\nexport let mode = "fast", level = 2;\nconst hidden = 1;\n';

    expect(names(text)).toEqual(['LIMIT', 'mode', 'level', 'hidden']);
    expect(symbol(text, 'LIMIT')?.signature).toBe('LIMIT:number');
    expect(symbol(text, 'mode')?.signature).toBe('mode="fast"');
    expect(symbol(text, 'hidden')).toMatchObject({ exported: false, text: 'const hidden = 1;' });
  });

  it('reads interfaces, type aliases and enums whole', () => {
    const text = [
      'export interface RetryOpts {\n  retries: number;\n}',
      'export type Mode = "fast" | "safe";',
      'export enum Level { Low, High }',
    ].join('\n');

    expect(names(text)).toEqual(['RetryOpts', 'Mode', 'Level']);
    expect(symbol(text, 'RetryOpts')?.signature).toBe('interface RetryOpts{retries:number;}');
    expect(symbol(text, 'Mode')?.signature).toBe('type Mode="fast"|"safe";');
    expect(symbol(text, 'Level')?.signature).toBe('enum Level{Low,High}');
  });

  it('names an anonymous default export "default", and marks a named one as the default in its signature', () => {
    expect(symbol('export default function () { return 1; }\n', 'default')?.signature).toBe('default()');
    expect(symbol('export default createClient();\n', 'default')?.signature).toBe('default=createClient()');
    expect(symbol('export default class Greeter {}\n', 'Greeter')?.signature).toBe('default class Greeter');
  });

  it('reads re-exports and export lists as exported symbols', () => {
    const text = "export { a as b } from './x';\nexport * from './y';\nfunction helper() {}\nexport { helper as util };\n";

    expect(names(text)).toEqual(['b', '*', 'helper', 'util']);
    expect(symbol(text, 'b')?.signature).toBe("b=from'./x'#a");
    expect(symbol(text, '*')?.signature).toBe("*=from'./y'");
    expect(symbol(text, 'util')?.signature).toBe('util=helper()');
  });

  it('collects code outside any declaration as top-level code, with the imports it uses', () => {
    const text = "import './polyfill';\nimport { a } from './a';\nconsole.log(a);\nexport function f() {}\n";

    expect(extractSymbols('src/x.ts', text)).toMatchObject({
      symbols: [{ name: 'f' }],
      topLevel: "import './polyfill';\nconsole.log(a);\nimport { a } from './a'",
      parseError: false,
    });
  });

  it('reports a file it cannot parse', () => {
    expect(extractSymbols('src/x.ts', 'export function (\n').parseError).toBe(true);
  });

  it('ties each import to the symbols that use it, so retargeting an import changes them', () => {
    const v1 = "import { calc } from './v1';\nexport function total(): number {\n  return calc();\n}\n";
    const v2 = v1.replace("'./v1'", "'./v2'");

    expect(symbol(v1, 'total')?.text).not.toBe(symbol(v2, 'total')?.text);
    expect(extractSymbols('src/x.ts', v2).topLevel).toBe('');
  });

  it('treats an import no symbol uses as top-level code, since importing runs the module', () => {
    const text = "import { unused } from './evil';\nimport legacy = require('./legacy');\nexport function f() {}\n";

    expect(extractSymbols('src/x.ts', text).topLevel).toBe("import { unused } from './evil'\nimport legacy = require('./legacy')");
  });

  it('gives a local export alias or default export the signature of what it points to', () => {
    const text = 'function foo(a: string): void {}\nexport { foo as bar };\nexport default foo;\n';

    expect(symbol(text, 'bar')?.signature).toBe('bar=foo(a:string):void');
    expect(symbol(text, 'default')?.signature).toBe('default=foo(a:string):void');
  });

  it("keeps a declarator's keyword, so const to let is a change", () => {
    const before = symbol('export const a = 1, b = 2;\n', 'a')?.text;
    const after = symbol('export let a = 1, b = 2;\n', 'a')?.text;

    expect(before).not.toBe(after);
  });

  it('reads a class index signature as a member', () => {
    expect(names('export class Bag {\n  [key: string]: number;\n}\n')).toEqual(['Bag', 'Bag.[index]']);
  });

  it('groups overloads into one symbol', () => {
    const text = [
      'export function parse(x: string): number;',
      'export function parse(x: number): number;',
      'export function parse(x: unknown): number { return Number(x); }',
    ].join('\n');

    expect(names(text)).toEqual(['parse']);
    expect(symbol(text, 'parse')?.signature).toBe('parse(x:string):number;parse(x:number):number;parse(x:unknown):number');
  });
});
