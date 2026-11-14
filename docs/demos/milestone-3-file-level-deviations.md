# Milestone 3: File-level Deviations

The gate now runs §5 steps 4–7 at file level. It compares the change (head against its merge-base with the base branch) with the approved Change Contract, fingerprints each Deviation, applies Sign-offs from the PR thread, and renders the result. `contract check` runs the whole gate locally.

## Deviation checks

Changes under `.contracts/` are governed by the structure rules (milestone 2), so these checks ignore them.

| Check | Kind | Fires when |
|---|---|---|
| `must-not-change` | Unplanned Change | A changed file matches a `mustNotChange` entry: a glob, or `path#*`, which covers the whole file. This wins over scope, and the file is reported only once. Single-symbol entries (`path#Name`) wait for milestone 4. |
| `ci-config` | Unplanned Change | An out-of-scope file matches the config's `ciConfigFiles`. The defaults cover `.github/**`, `.gitlab-ci.yml`, tsconfig, ESLint and Prettier configs, Biome, Jest and Vitest configs, `.npmrc` and the gate's own `.change-contract.json`. |
| `scope` | Unplanned Change | Any other changed file that no `scope.files` glob covers. Here `*` stays within one folder, and `**` spans folders. |
| `dependencies` | Unplanned Change | A `package.json` adds, removes or bumps something in `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies` that no Clause allows. A Clause allows a change when its name and kind match and, if it gives a range, the range matches. |
| `dependencies` | Unplanned Change | A lockfile changes, but the contract declares no dependency change and the change makes none. In v1, lockfile contents aren't parsed. |
| `dependencies` | Unmet Clause | A declared dependency change didn't happen. |

A `package.json` edit outside the dependency fields, such as `scripts`, goes through the scope rules like any other file.

## Fingerprints, IDs and Sign-offs

- **Fingerprint:** `sha256` of the kind, check, target and normalized content, with line endings unified and trailing whitespace removed.
  - For a file Deviation, the content is the file before and after.
  - For a dependency Deviation, it's the manifest and field, the kind of change, both ranges, and the content of every changed lockfile. So a lockfile change after a Sign-off lapses it.
  - For an Unmet Clause, it's the Clause.
- **Display ID:** `D` plus the first 16 hex characters of the fingerprint, as recorded in ADR 0004.
- **Sign-offs:**
  - Each line of the form `/signoff <id> accept "<reason>"` or `/signoff <id> reject ["<reason>"]` is one Sign-off.
  - Commands are read from every non-bot comment, ignoring fenced code blocks.
  - The Sign-off Policy applies, and the latest valid Sign-off per Deviation wins.
  - If a Sign-off names an ID that no longer exists, because the content changed, it lapses and the gate says so.
- **Command errors:** malformed commands, unknown commands, accepts with no reason, and Sign-offs the policy refuses each become a `commandError`. The adapter will reply to these in milestone 6.
- **Pass rule:** steps 2–3 pass and every Deviation is accepted.

## Output

- **`renderSummary(result)`** returns Markdown: the verdict, the notes, any failures, a Deviation table (ID, kind, target, status, and the exact `/signoff` command), each Deviation's detail, and the commands the gate couldn't act on.
- **`buildRunSummary(input, result, …)`** returns the pilot metrics:
  - Deviation counts by kind and by check
  - Sign-off outcomes
  - failure counts by rule
  - approval latency (from the Contract Commit to the approval comment)
- **`GateResult.approval`** records the accepted Contract Approval: who approved, which Approval Commit, and the comment's URL and time.

## `contract check`

```console
$ contract check --base main
## Change Contract gate: ❌ fail

- Agent-authored PR: checked locally with `contract check`, which assumes it is one.
- Change Contract .contracts/say-hi.json approved by reviewer in Approval Commit 1c9e2f4.
- Checked locally: comments aren't available, so the approval comment and Sign-offs weren't verified.

### Deviations

| ID | Kind | Target | Status | Sign off |
| --- | --- | --- | --- | --- |
| `D5be0c2d71a9f3e04` | Unplanned Change | `src/farewell.ts` | unsigned | `/signoff D5be0c2d71a9f3e04 accept "<reason>"` |

- `D5be0c2d71a9f3e04`: src/farewell.ts is added, but no scope Clause covers it.
```

- **Flags:** `--head <ref>` (default `HEAD`), `--json` for the raw GateResult, and `--run-summary <file>`.
- **Exit codes:** 0 when the gate passes, 1 when it fails, 2 on a usage error.
- **Config:** read from `.change-contract.json` **on the base ref**, so a PR can't loosen the rules it's checked by. Its optional `bot` key sets the Approval Commit identity. The default is GitHub's `github-actions[bot]`.

## Also in this milestone

- **Merge commits** (decision 2): a merge's files are the paths whose result differs from *every* parent. Merging the base branch therefore adds nothing of its own, even when it brings in other PRs' contracts. Anything slipped into the merge itself is still checked. Covered by three fixtures.
- **Approval replay** (decision 1): recorded in ADR 0003. The host adapter verifies ordering in milestone 6.
- **Fixture builder:** rewritten to use one `git fast-import` per fixture, and `readCommits` now uses one `git log` call. On this Windows machine, git start-up is the main cost.
- **Fixture placeholders:** `{{id:<kind>:<check>:<target>[@N]}}` and `{{fingerprint:…}}`, resolved by running the gate as of head or commit N.

## Tests

- 65 gate fixtures, the `contract check` CLI as a subprocess, and core unit tests: 84 tests in all.
- Every file-level check has passing and failing fixtures.
- Sign-off fixtures cover: accept, reject, latest wins, an accept with no reason, a PR-author Sign-off, carry-over, lapse, and malformed commands.

## Fixed after code review

- **Approval order is ancestry, not list position.** Every code commit must build on the Approval Commit. Code written on a side branch before the approval and merged in afterwards now fails `approval-after-code`.
- **Paths are read raw (`git -z`).** Git used to quote non-ASCII paths, so their content wasn't read: the fingerprint never changed, and the path matched no scope glob.
- **Dependencies are tracked per field.** A name added to a second field, a move between fields, and a newly added or deleted `package.json` are all caught.
- **Lockfile content is part of each dependency Deviation's fingerprint.**
- **Command prefixes are case-insensitive**, so `/SIGNOFF …` is never silently ignored.
- **Every `commandError` has a `rule`:** `command-unreadable`, `command-unknown`, `signoff-needs-reason`, `signoff-not-allowed` or `signoff-lapsed`.
- **The fingerprint formula is documented** consistently in ADR 0004, PLAN §5.5 and CONTEXT.md.

## Open items

- **Lockfiles are compared at file level only.** A dependency change that is declared, or actually made, lets lockfile changes through when it is planned. A planned change has no Deviation to lapse, so unrelated transitive bumps can ride along. Parsing lockfiles is a candidate for milestone 8.
- **Edited comments.** "Latest Sign-off wins" uses each comment's creation time. An edited older comment doesn't override a newer one, which is the safer reading. The adapter can add edit times in milestone 6 if needed.
- **The CLI's default bot is GitHub's `github-actions[bot]`.** That's a host default in a host-neutral CLI. Set `bot` in `.change-contract.json` to override it.
- **Symbol-level `mustNotChange` entries (`path#Name`) are ignored until milestone 4.**
