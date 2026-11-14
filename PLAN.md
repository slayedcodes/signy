# Build plan: Change Contract gate

> For Claude Code. Read `CONTEXT.md` and `docs/adr/` first. Use the glossary terms exactly as they're defined there, in code, messages and docs. Build test-first (red → green → refactor), one tracer bullet at a time, and keep every milestone shippable.

## 1. Goal

Agent-authored PRs should be reviewed against a contract that a human approved before any code was written. Every Deviation from that contract must get a human Sign-off before the PR can merge. The tool works with any Producing Agent. Its core is independent of the code host, and GitHub is the first adapter.

## 2. Settled decisions (don't revisit without asking)

| Area | Decision |
|---|---|
| Scope | Change Contract only. Risk tiers and replay-verified collapse are out of scope. |
| Architecture | Host-neutral TS core + CLI, plus a thin GitHub adapter (ADR 0001). |
| Pilot stack | TypeScript/Node repos, with Jest or Vitest tests. |
| Producing agents | Any agent. The Claude Code skill is just one producer. |
| Contract file | `.contracts/<slug>.json`, validated by a published JSON Schema (`$schema` reference). Kept after merge as history. |
| Contract Commit | Commit 1 of the PR adds exactly one contract and nothing else. No later commit may add, remove or replace a contract file. |
| Approval | A `/contract approve` comment → the bot pushes an empty Approval Commit (ADR 0002). Code commits are allowed only after it. The `contract approve` CLI posts that comment for you. |
| Deviation | Both kinds count: Unplanned Change and Unmet Clause. |
| Sign-off | `/signoff <id> accept "<reason>"` or `/signoff <id> reject "<reason>"`. Accept requires a reason. A Sign-off never changes the contract; a change of scope means a new Contract Version and a new approval. |
| Sign-off Policy | Configurable. Default: any human with write access, excluding the PR author and all bots. Applies to both approvals and Sign-offs. |
| Sign-off validity | Tied to the Deviation Fingerprint (kind + target + content hash). A Sign-off carries over while the fingerprint is unchanged and lapses if the content changes. |
| Agent detection | Configurable rules (bot author, `Co-Authored-By` trailer naming a known agent, label, branch pattern); any match counts. Override labels work in both directions. |
| Agent PR without a contract | Fail, with a message pointing to `contract init`. |
| Reject flow | No auto-triggering of agents in v1. The gate stays failed; `contract feedback` prints rejections as an agent-readable prompt. |
| State | Nothing beyond the repo and the PR thread. Comments are re-read on every run. |
| Distribution | One npm package plus a thin GitHub Action wrapper. The Claude Code skill ships through a plugin marketplace in the same repo. If npm isn't reachable, ship a single vendored bundle. |

## 3. Repo layout

```
/
├── CONTEXT.md
├── docs/adr/
├── package.json                    # pnpm workspace
├── schema/change-contract.schema.json
├── packages/
│   ├── core/                       # pure logic, no I/O beyond a git reader interface
│   ├── cli/                        # `contract` binary
│   ├── adapter-github/             # fetch PR, comments, commits; post check; push Approval Commit
│   └── action/                     # GitHub Action wrapper (action.yml + entry)
├── .claude-plugin/marketplace.json # plugin marketplace manifest
├── plugins/change-contract/
│   ├── .claude-plugin/plugin.json
│   └── skills/change-contract/SKILL.md
└── fixtures/                       # fixture repos for tests (see §9)
```

## 4. Contract schema (v1)

```jsonc
{
  "$schema": "https://<pkg>/change-contract.schema.json",
  "version": 1,
  "slug": "add-retry-to-billing-client",
  "issue": "https://…",                 // optional link
  "summary": "Why this change exists, in one paragraph.",
  "scope": {
    "files":   ["src/billing/client.ts", "src/billing/retry.ts"],
    "symbols": ["src/billing/client.ts#BillingClient.charge", "src/billing/retry.ts#withRetry"]
  },
  "interface": [
    { "symbol": "src/billing/retry.ts#withRetry", "change": "add",
      "signature": "withRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T>" }
  ],
  "dependencies": [ { "name": "p-retry", "change": "add", "range": "^6" } ],
  "tests": [
    { "file": "src/billing/retry.test.ts", "name": "retries 3 times on 503", "change": "add" }
  ],
  "mustNotChange": ["src/billing/ledger/**", "src/api/public.ts#*"],
  "forks": [
    { "id": "F1", "question": "Retry on 429?", "options": ["yes", "no"], "chosen": "no",
      "rationale": "Upstream rate limits are enforced per hour." }
  ]
}
```

- Symbols use the form `path#Name` or `path#Class.member`, at top-level and class-member granularity.
- Lint the contract itself. Reject scope globs wider than one directory level (for example `src/**`), an empty scope, and duplicate symbols.
- Forks are recorded only. v1 doesn't check them.

## 5. Gate pipeline (core)

The core's pure entry point is `runGate(input) → GateResult`. Its input is:
- the PR base and head
- the ordered commits, each with its author and file list
- the git reader
- the comments, each with its author, permission, timestamp and URL
- the config
- the bot identity

Run these checks in order, and collect every failure. Don't stop at the first one.

1. **Agent detection.** Apply the configured rules. If the PR isn't agent-authored, pass with a "not applicable" note.
2. **Contract structure.**
   - Commit 1 adds exactly one `.contracts/*.json` file and nothing else.
   - No later commit adds, deletes or replaces a contract file, or edits an older one.
   - The contract passes schema validation and its own lint.
3. **Approval.**
   - An Approval Commit exists right after the Contract Commit, or before any code commit.
   - The configured bot identity authored it, and it is empty.
   - Its trailers `Contract-Hash: sha256:…`, `Approved-By: <login>` and `Approval-Comment: <url>` match a real `/contract approve` comment, from an approver the policy allows, on that hash.
   - No commit containing code comes before it.
   - Failure messages name the exact rule that failed.
4. **Deviation detection.** Compare against the merge-base:
   - **Scope:**
     - A changed file that isn't in `scope.files` → Unplanned Change.
     - A changed symbol inside an in-scope file that isn't in `scope.symbols` → Unplanned Change.
     - Use the TypeScript compiler API to map hunks to symbols.
   - **Interface:**
     - Diff the exported declarations at base vs head.
     - An unplanned change → Unplanned Change.
     - A declared change that's missing or has a different signature → Unmet Clause.
   - **Dependencies:**
     - Diff `package.json` and the lockfile.
     - An unplanned add, remove or bump → Unplanned Change.
     - A declared change that's missing → Unmet Clause.
   - **Tests:**
     - A declared test that's missing → Unmet Clause.
     - Test weakening → Unplanned Change, unless the contract declares it. That means any of:
       - a test or `it`/`test` block deleted
       - an assertion removed
       - `.skip`, `.only` or `.todo` added
       - a snapshot file rewritten
       - a matcher loosened, according to a fixed list of pairs, for example `toEqual→toBeTruthy` and `toStrictEqual→toEqual`
   - **Must-not-change:** any change matching an entry → Unplanned Change, regardless of scope.
   - **CI or config files** (workflows, `tsconfig`, lint configs, the gate config) count as Unplanned Changes unless they're in scope.
5. **Fingerprint and IDs.**
   - Fingerprint = `sha256(kind + target + normalized content)`.
   - The display ID (`D1`, `D2`, …) is assigned from the fingerprint so it stays stable across runs.
6. **Sign-offs.**
   - Parse `/signoff` comments.
   - Keep only those whose author the policy allows and whose fingerprint still matches.
   - The latest valid Sign-off per Deviation wins.
7. **Result.**
   - Pass only if steps 2 and 3 pass and every Deviation has an Accept.
   - A Reject, or no Sign-off at all, fails.
   - Output a human-readable summary: a table of Deviations with ID, kind, target, status and the exact command to sign off.
   - Also output a machine `run-summary.json` with the PR, timestamps, Deviation counts by kind, Sign-off outcomes and approval latency, for the pilot metrics.

## 6. Comment command grammar

```
/contract approve [sha256:<hash>]      # hash optional; defaults to the current contract's hash
/signoff <Dn> accept "<reason>"        # reason required
/signoff <Dn> reject "<reason>"
```

- One command per line. Several lines in one comment are allowed.
- Unknown or malformed commands get a reply explaining the syntax.
- They are never silently ignored.

## 7. GitHub adapter and Action

- **Triggers:** `pull_request` (opened, synchronize, reopened, labeled) and `issue_comment` (created, edited).
- **On `/contract approve`:**
  1. Validate it via core.
  2. Push the empty Approval Commit as the bot.
  3. **Run the gate in the same job.** Pushes made with `GITHUB_TOKEN` don't trigger workflows.
  4. Make sure this can't loop.
- Report results as a check run named `change-contract`, and keep one PR comment updated in place with the summary.
- Get commenter permission from the collaborator permission API. Detect bots by account type.
- Upload `run-summary.json` as a workflow artifact.

## 8. CLI (`contract`)

| Command | Does |
|---|---|
| `contract init --issue <url\|text>` | Scaffolds `.contracts/<slug>.json` from a template, prompting for anything missing. It never commits. |
| `contract validate [file]` | Schema validation plus contract lint. |
| `contract check --base <ref>` | Runs the full gate locally against the working branch, with no host. Agents use it to self-check before pushing. |
| `contract approve` | Posts `/contract approve sha256:<hash>` through the adapter, using the user's token. |
| `contract feedback` | Prints rejected and unsigned Deviations as an agent-readable prompt. |

## 9. Claude Code plugin and skill

- Add `.claude-plugin/marketplace.json` listing the `change-contract` plugin, so users can install it with `/plugin marketplace add <repo>`.
- The skill steps:
  1. Draft the contract from the issue with `contract init`, and fill it in by reading the codebase.
  2. Run `contract validate`.
  3. Make commit 1 with only the contract, open a draft PR, and stop. Tell the user to approve.
  4. After the Approval Commit lands, code within the contract.
  5. Run `contract check` before each push, and fix or explain any Deviations in the PR description.
  6. When the gate reports rejections, run `contract feedback` and rework.
- The skill must never push code before the Approval Commit, and never edit the contract after approval. A change of scope means opening a new Contract Version and asking for approval again.

## 10. Testing

- **Fixture repos:** each fixture has a base, ordered commits, a contract, comments and config, plus `expected.json` (a GateResult). They are built by a small script with `git init` in a temp directory. Don't check binary repos into git.
- Cover every rule in §5 with at least one passing fixture and one failing fixture, including:
  - approval before vs after code
  - a forged Approval Commit (wrong author, or no matching comment)
  - an approval from the PR author (rejected under the default policy)
  - fingerprint carry-over vs invalidation after a new push
  - two contracts in the PR, or none
  - a contract edited after approval
  - each of the five test-weakening kinds
  - must-not-change winning over scope
- **Adapter:** tests against recorded GitHub API responses. No live calls in CI.

## 11. Milestones (tracer bullets)

Each milestone ends with green tests and a short demo note in `docs/demos/`.

1. **Skeleton.** Monorepo, schema, `contract validate`, and a fixture harness that runs one trivial fixture end to end through `runGate`.
2. **Structure and approval.** Steps 1–3 of §5, with all approval and forgery fixtures.
3. **File-level Deviations.** Scope (files), Dependencies, Must-not-change, CI/config, fingerprints, Sign-off parsing, result rendering. After this, `contract check` is usable locally.
4. **Symbol-level Deviations.** Scope (symbols) and Interface, via the TS compiler API.
5. **Tests clauses and test weakening.**
6. **GitHub adapter and Action.** Check run, summary comment, Approval Commit push, permissions, run summary artifact. Demo it on a sandbox repo.
7. **CLI `init`, `approve`, `feedback`, plus the Claude Code plugin and skill.** Install the plugin through the marketplace in a clean environment and do one full PR cycle.
8. **Pilot hardening.** Run against 20 historical agent PRs from the pilot repo in `check` mode, tune the contract lint, and write the pilot README with the metrics from §5.7.

## 12. Out of scope for v1

- Risk tiers and sampling
- Replay-verified collapse
- OpenAPI and DB-schema clauses (design them as plug-in checkers later)
- A precedent store for forks
- The GitLab adapter
- Any LLM call inside the gate
- Auto-triggering agents on Reject

## 13. Known risks to watch

- **Loose contracts** can make the gate meaningless, and **over-strict ones** flood reviewers with Deviations. Mitigation: the contract lint, plus tracking deviations per PR.
- **Symbol mapping edge cases:** re-exports, default exports, overloads, generated files. Treat ambiguous cases as Unplanned Changes, never as silently in scope.
- **Branch protection:** `change-contract` must be a required check, and the bot must be allowed to push to PR branches.
- **Rewritten history** (force-push or rebase) drops the Approval Commit, so the gate fails. Document that the fix is to re-approve.
