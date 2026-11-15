# Milestone 5: Tests Clauses and Test Weakening

The gate now reads the tests in every changed test file (`testFiles`, by default `**/*.test.*`, `**/*.spec.*` and `**/__tests__/**`) and every changed Jest or Vitest snapshot file. It reports Test Weakening as an Unplanned Change, and tests Clauses the change doesn't fulfil as Unmet Clauses. Both use the check `tests`.

## Tests

`extractTests(path, text)` parses one test file with the TypeScript compiler API, without running it.

- **Blocks:** `describe`, `suite`, `it` and `test`, including `xit`, `fit`, `xdescribe`, `fdescribe` and chained forms such as `it.skip`, `test.concurrent.only`, `it.skipIf(cond)` and `it.each(table)`. The test function is the last function argument, so a Vitest options object before it is fine.
- **Names:** a block's name is its describe titles and its own title joined by spaces, the way Jest and Vitest name tests and snapshots (`greet says hi`). A repeated name gets its position (`same [2]`). Each block also records the names of its enclosing describe blocks.
- **Modifiers:** `skip` (also `xit`, `skipIf`, `runIf`), `only` (also `fit`) and `todo`.
- **Assertions:** `expect(x)…matcher(…)` with any chain such as `.not` or `.resolves`; `expect.soft` and `expect.poll`; `expect.assertions(n)` and `expect.hasAssertions()`; `assert(…)` and `assert.method(…)`. Each records its subject, matcher and the matcher's arguments.

In Deviations, a test is named `file > name`, for example `src/greet.test.ts > greet says bye`.

## Test Weakening

| Kind | Fires when | Excused by a tests Clause |
|---|---|---|
| Test deleted | A test that existed at the merge-base is gone. | `remove` |
| Assertion removed | An assertion is gone and no assertion on the same subject with the same matcher replaces it. Changing only the expected value is an edit, not a removal. | `modify` |
| `.skip` / `.only` / `.todo` added | An existing block gains one of these, or a **new** block is marked `.only`, which skips every other test. On a describe block it's one Deviation, on that block. | `modify` (`add` for a new `.only` block) |
| Snapshot rewritten | An existing entry in a `__snapshots__/*.snap` file changes or is removed. It is reported on the entry's test, in the test file the snapshot belongs to. New entries only add, so they don't count. | `modify` |
| Matcher loosened | An assertion on the same subject switches to a looser matcher from a fixed list, or keeps its matcher but loses its arguments (`toThrow('empty name')` → `toThrow()`). | `modify` |

The fixed list of loosened matchers:
- `toStrictEqual` → `toEqual`, `toMatchObject`
- `toEqual` / `toBe` → `toMatchObject` (`toBe` also → `toEqual`)
- anything precise (`toStrictEqual`, `toEqual`, `toBe`, `toMatchObject`, `toHaveLength`, `toContain`, `toContainEqual`, `toMatch`) → `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `not.toBeNull`, `not.toBeUndefined`
- `toBeNull` / `toBeUndefined` → `toBeFalsy`
- `toHaveBeenCalledWith`, `toHaveBeenCalledTimes`, `toHaveBeenCalledOnce`, `toHaveBeenLastCalledWith`, `toHaveBeenNthCalledWith`, `toHaveBeenCalledExactlyOnceWith` → `toHaveBeenCalled`

A `.resolves` or `.rejects` prefix has to stay the same on both sides.

Each weakened block is one Deviation, and its detail lists every way it is weakened, snapshot rewrites included.

## Tests Clauses

A Clause names a block by its full name, or by its own title when exactly one block in the file has that title. A Clause naming a describe block covers everything inside it, the way a listed class covers its members.

**Ambiguous names cover nothing.** If two blocks share the title, the Clause covers neither, and it is reported as unmet with a hint to name the test in full (§13: ambiguous cases are never silently planned).

| Clause `change` | Met when |
|---|---|
| `add` | The test exists at head and didn't at the merge-base. |
| `modify` | The test exists on both sides and its text changes, or only its snapshot is rewritten. |
| `remove` | The test existed at the merge-base and is gone. |

An unmet tests Clause reads, for example, "The Change Contract declares adding the test src/greet.test.ts > says hi in French, but the change doesn't."

## Decisions made in this milestone

- **Test Weakening is checked whether or not the test file is in scope.** An out-of-scope test file is one scope Deviation, and its weakened tests are reported as well. Accepting "this file changed" shouldn't silently accept "and its assertions were deleted". Interface changes are handled differently: they aren't reported a second time for out-of-scope files.
- **Adding tests is never a Deviation**, unless the new block is `.only`. Scope still decides whether the test file may change at all.
- **A test file that no longer parses** is an Unplanned Change (`file > <unparsed>`), because weakening can't be ruled out. A file that had no tests before is exempt.

## Tests

- **8 `extractTests` unit tests** (the new seam): a test and its assertions, nested names and enclosing describes (including `suite`), modifiers in every spelling, assertion forms, a Vitest options argument, repeated names, and parse errors.
- **21 new gate fixtures:**
  - each of the five kinds, failing: `test-deleted`, `assertion-removed`, `test-skipped`, `test-turned-todo`, `only-on-new-test`, `describe-only`, `snapshot-rewritten`, `matcher-loosened`, `matcher-arguments-dropped`
  - each kind excused by a Clause: `test-removal-declared`, `assertion-removal-declared`, `skip-declared`, `snapshot-rewrite-declared`, `snapshot-update-declared` (only the snapshot changes), `weakening-declared`
  - not weakening: `assertion-edited`, `snapshot-appended`
  - tests Clauses: `test-clause-added` (met), `test-clause-missing` (unmet), `test-clause-title-ambiguous`
  - `test-weakened-out-of-scope` and `test-file-unparseable`

**Test-first:**
- These were each seen failing before their code was written:
  - the `extractTests` unit tests
  - the `test-deleted` and `snapshot-rewritten` fixtures
  - the review-fix fixtures `only-on-new-test`, `matcher-arguments-dropped`, `test-clause-title-ambiguous` and `snapshot-update-declared`
- The first version of the weakening comparison was written in one go after `test-deleted`. The fixtures added for it, and `skip-declared`, `assertion-removal-declared` and `test-turned-todo`, passed as soon as they were written. They pin behaviour rather than drive it.

## Fixed after code review

- **A new `.only` block** is weakening, because it skips every existing test.
- **The Vitest options argument** (`it('a', { timeout }, fn)`) no longer hides the test body.
- **Rewriting only a snapshot meets a `modify` Clause.** Snapshot rewrites are now reported on the test they belong to, so they follow the same Clause rules as every other weakening.
- **Clauses excuse only what they name.** One resolution rule (full name, else a unique title, with describe blocks covering their contents structurally) replaced the earlier rules. Those let a bare title excuse same-titled tests in other describe blocks, and let `g` cover a describe named `g h`.
- **`suite()`** is a describe block.
- **A matcher that loses its arguments** is loosened.

## Open items

- **Moved tests:** moving a test to another file reads as a deletion, because files are compared one at a time.
- **Positional names:** a repeated name is told apart by position (`same [2]`), so inserting another `same` earlier in the file shifts the identities.
- **Assertion edits aren't judged.** These count as edits and aren't flagged:
  - changing an expected value (`toEqual({ x: 1, y: 2 })` → `toEqual(f())`)
  - dropping `await` in front of `.resolves`
  - shrinking an `it.each` table
- **Code outside the test's own body isn't tracked:**
  - assertions in helper functions and hooks such as `beforeEach`
  - neutralising a test with an early `return`, `if (false)` or `ctx.skip()`
  - `it.fails`
  - custom test functions such as `test.extend(…)`
  - inline snapshot rewrites (`toMatchInlineSnapshot`), which count as assertion edits
- **An `add` Clause excuses `.only` on the test it adds.**
