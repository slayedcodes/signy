# Milestone 1: Skeleton

## What's in it

- **pnpm workspace** with `packages/core` (pure logic) and `packages/cli` (the `contract` binary). Vitest runs everything from the root with `pnpm test`; `pnpm typecheck` runs `tsc`.
- **Published JSON Schema** at `schema/change-contract.schema.json` (v1, from PLAN.md §4).
- **`validateContract(contract)`** in core: runs the schema check first, then the contract lint, which only runs on schema-valid contracts. The lint rules:
  - `scope-glob-too-wide`: a `scope.files` glob that contains `**` or has a wildcard in a directory segment.
  - `scope-empty`: `scope.files` is empty.
  - `duplicate-symbol`: a symbol appears twice in `scope.symbols`, or two `interface` Clauses name the same symbol.
- **`contract validate [file…]`**: exits 0 when every file is valid and 1 otherwise. With no argument it validates every `.contracts/*.json`, and when there are none it points to `contract init`.
- **Fixture harness** (`fixtures/harness.test.ts`): each `fixtures/<name>/` directory holds a `fixture.json` (base files, ordered commits, PR author, comments, config, bot identity) and an `expected.json` (a GateResult). The harness builds a throwaway git repo with `git init` in a temp directory, using fixed dates so SHAs are reproducible. It reads the commits back through the CLI's git reader, runs `runGate`, and compares the result with `expected.json`.
- **`runGate`** is a stub. It returns "not applicable" for every PR until agent detection lands in milestone 2. One fixture covers it: `not-agent-authored`.

## Demo

```console
$ cat .contracts/add-retry.json
{
  "version": 1,
  "slug": "add-retry",
  "summary": "Retry transient 503s from the billing API.",
  "scope": { "files": ["src/**"], "symbols": ["src/billing/retry.ts#withRetry", "src/billing/retry.ts#withRetry"] }
}

$ node packages/cli/bin/contract.js validate
.contracts/add-retry.json: invalid Change Contract
  /scope/files/0 [scope-glob-too-wide] "src/**" matches more than one directory level; list the files or use a single-level glob such as "src/billing/*".
  /scope/symbols/1 [duplicate-symbol] "src/billing/retry.ts#withRetry" is already listed at /scope/symbols/0.
$ echo $?
1

$ pnpm test
 Test Files  3 passed (3)
      Tests  13 passed (13)
```

## Notes and open items

- `runGate` must not be wired to a host before milestone 2, because right now it passes every PR.
- The CLI runs its TypeScript source through `tsx` (`packages/cli/bin/contract.js`). Bundling for npm comes with distribution work.
- The schema's `$id` uses a placeholder package URL (`https://unpkg.com/@change-contract/core/schema/…`). It needs fixing once the npm package name is settled.
- Fixture repos set `commit.gpgsign=false` and `core.autocrlf=false` locally, so the user's git config can't break or alter them.
