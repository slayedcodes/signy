# Milestone 4: Symbol-level Deviations

The gate now reads TypeScript and JavaScript sources with the TypeScript compiler API. It checks the scope at symbol level, applies `path#Name` must-not-change entries, and diffs each module's public interface against the interface Clauses.

The core depends on `typescript@5.9.3` for parsing. TypeScript 7, which the repo uses for type checking, only offers its JavaScript API as `unstable/*`.

## Symbols

`extractSymbols(path, text)` parses one file without type checking.

| Source | Symbol | Interface signature (only when exported) |
|---|---|---|
| `export function greet(name: string): string` | `greet` | `greet(name:string):string` |
| overloads | one symbol | each overload, joined with `;` |
| `export class C<T> extends B` | `C` (the class header only) | `class C<T>extends B` |
| class members | `C.member`, `C.constructor`, `C.#private` | public members only; `static` is marked |
| `export const f = (a: A): R => …` | `f` | `f(a:A):R` |
| other variables | each name | `x:Type`, or `x=<initializer>` when unannotated |
| interface, type alias, enum, namespace | its name | the whole declaration |
| `export default function () {}` / `export default expr` | `default` | `default()` / `default=expr` |
| `export default class Greeter` | `Greeter` | `default class Greeter` |
| `export { a as b } from './x'`, `export * from './y'`, `export { local as alias }` | `b`, `*`, `alias` | `b=from'./x'#a`, `*=from'./y'`, `alias=local` |

- **Normalized signatures:** whitespace is dropped except between two words, so reformatting never reads as an interface change.
- **Top-level code** is collected separately: side-effect imports, top-level calls and `export =`. Named imports are ignored, since they follow from the code that uses them.
- **Syntax errors** are reported, because a file that doesn't parse can't be trusted to map onto symbols.

## Checks

| Check | Fires when |
|---|---|
| `must-not-change` | A changed symbol matches a `path#Name` entry. Naming a class protects all its members. This applies to every file, in scope or not, and wins over scope. |
| `scope` (symbol) | An in-scope file whose scope **lists symbols** changes a symbol that isn't listed. Listing `path#Class` covers its members. |
| `scope` (`path#<top-level>`) | Top-level code changes in such a file. |
| `scope` (`path#<unparsed>`) | Such a file doesn't parse. If the file has `path#Name` must-not-change entries, it's reported as must-not-change instead. |
| `interface` (Unplanned Change) | An exported signature is added, removed or changed with no interface Clause allowing it. A Clause allows a change when the symbol and kind match and, if it gives a signature, that signature matches after normalization. |
| `interface` (Unmet Clause) | A declared interface change didn't happen, or happened with a different signature. |

**Decisions made in this milestone**
- **Granularity (your choice):** a file in `scope.files` with *no* listed symbols is in scope as a whole. Symbols tighten the scope only for files that list some. A new export is still an interface Deviation (fixture `interface-addition-in-file-scope`).
- **No double-reporting:** a file that is out of scope is already one whole-file Unplanned Change. Its interface changes still count towards meeting interface Clauses, but don't produce a second Deviation.
- **Test files** (`testFiles`, default `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`) get symbol scope and must-not-change like any source file, but their exports aren't public interface. Test Clauses and test weakening come in milestone 5.
- **Files the compiler API can't read** (JSON, Markdown, …) fail safe. A `path#Name` must-not-change entry, or symbols listed in their scope, make any change to them unplanned (`path#<not-source>`).

## Fixed after code review

- **Imports are tied to the symbols that use them.** Pointing `import { calc }` at another module changes every symbol that uses `calc`. An import that nothing uses counts as top-level code, because importing a module runs it.
- **Local aliases resolve.** `export { foo as bar }` and `export default foo` carry `foo`'s signature, so changing `foo` changes the interface.
- **Declarators keep their keyword.** In `let a = 1, b = 2`, each declarator keeps `let`/`const`, so changing the keyword is a change.
- **Class index signatures** are members (`Class.[index]`).
- **Clause signatures match in canonical form.** Modifier keywords (`static`, `async`, `default`, …) and a member's `Class.` prefix are ignored when matching, so `charge(...)` matches `Client.charge(...)`. The interface diff itself still compares full signatures.
- **`path#Name` must-not-change entries are always checked:** in test files, and conservatively in non-source files.

## Tests

- **16 `extractSymbols` unit tests** (the new seam): functions, classes and members, private members, arrow consts, variables, interfaces, types, enums, default exports, re-exports and aliases, imports tied to symbols, unused imports, declarator keywords, index signatures, top-level code, parse errors, and overloads.
- **16 new gate fixtures:**
  - symbol out of scope
  - class members in and out of scope
  - a file with no listed symbols
  - top-level code
  - symbol-level must-not-change, including in a test file and in a JSON file
  - interface Clauses: met, wrong signature, missing, and a method Clause in short form
  - interface addition in a whole-file scope
  - an unparseable file
  - test files with and without listed symbols

## Open items

- **No type checker:** an unannotated variable's or property's interface signature is its initializer text, so changing the value of an exported, unannotated constant counts as an interface change. Annotating exports avoids this.
- **Re-exports are compared by name and source, not by what they point to.** If a re-exported symbol changes in its own module, that module's interface diff catches it. The re-export doesn't.
- **Generated files** aren't special-cased. List them in scope, or have the reviewer accept them.
- **CommonJS and expando exports are not interface.** `module.exports = …` and `fn.extra = …` don't appear in the interface diff. In a file whose scope lists symbols, they are still top-level code, and so still Deviations.
- **Syntax errors come from a TypeScript internal** (`parseDiagnostics`), which is why `typescript` is pinned to exactly 5.9.3.
