---
name: change-contract
description: Change Contract workflow for agent-authored PRs. Use when making a PR in a repo that has a .contracts/ folder or a .change-contract.json file, when the user mentions a Change Contract, or when a change-contract check or its feedback needs rework.
---

# Change Contract

The repo's gate checks every agent-authored PR against a **Change Contract**: a JSON statement of what the PR will and won't change, which a human approves (a **Contract Approval**) before any code is written. Every gap between the Change Contract and the final change is a **Deviation** that a human has to sign off. Your job: make the Change Contract honest, get it approved, then stay inside it.

Run the CLI that ships with this plugin as `node "<this skill's base directory>/../../bin/contract.cjs" <command>`, with the path quoted. Below it is written `contract <command>`.

## Steps

### 1. Draft the Change Contract

1. Create a branch named `claude/<slug>`. The gate recognises agent-authored PRs by that branch prefix.
2. Run `contract init --issue "<issue URL or text>" --summary "<why, one paragraph>" --slug <slug>`. It writes `.contracts/<slug>.json`.
3. Read the code the issue touches until you can name every file and symbol the change needs. Then fill in the Clauses (see **Clauses** below).

Done when every file you expect to change is in `scope.files`, and every interface, dependency and test change you expect has its Clause.

### 2. Validate

Run `contract validate` and fix every error it lists. Done when it prints `valid Change Contract`.

### 3. Commit the Change Contract, open a draft PR, and stop

1. Make commit 1 with only `.contracts/<slug>.json`, and push with `git push -u origin claude/<slug>`.
2. Open a **draft** PR whose description summarises the Change Contract.
3. Tell the user the Change Contract is ready for review. A reviewer approves it by commenting `/contract approve` on the PR, or by running `contract approve`. Then end your turn.

Done when the draft PR exists and the user knows it awaits their Contract Approval. The Contract Approval is the human's act, so your work resumes when the user says the Change Contract is approved.

### 4. Code within the Change Contract

1. Run `git pull --ff-only`. The gate has pushed an empty **Approval Commit** ("Approve Change Contract <slug>", by the gate bot) onto the branch. Run `contract feedback` and confirm it no longer says the Change Contract is waiting for its Contract Approval.
2. Make the change on top of the Approval Commit, touching only what the Change Contract names.

The Change Contract stays exactly as approved: commits after commit 1 leave `.contracts/` untouched. When the work needs something the Change Contract doesn't name, that is a change of scope. It needs a new **Contract Version**, which means a new PR with a new Change Contract and a fresh Contract Approval. Stop and ask the user, describing what's missing and why.

Done when the change is made and committed on top of the Approval Commit.

### 5. Self-check before every push

Run `contract check --base origin/<base branch>` before each push. Fix each Deviation it lists, or keep it and explain it in the PR description so a reviewer can sign it off. Done when `contract check` passes, or every remaining Deviation is explained in the PR description.

### 6. Rework from feedback

When the user says the gate failed or a reviewer rejected something, run `contract feedback`. It prints the rejected and unsigned Deviations, with what to do about each. Rework them, then go back to step 5.

Done when `contract feedback` exits 0, or every Deviation it still lists is explained in the PR description for a reviewer to sign off.

## Clauses

`contract init` writes the template; `schema/change-contract.schema.json` in the gate's repo is the full definition.

- **`scope.files`**: every file the change touches. Name files, or globs within one directory (`src/billing/*`).
- **`scope.symbols`**: `path#Name` or `path#Class.member`. Listing symbols for a file narrows that file to those symbols; any other symbol or top-level code changed in it is a Deviation. List no symbols for a file to put the whole file in scope.
- **`interface`**: each exported signature you add, remove or modify: `{ "symbol": "path#Name", "change": "add", "signature": "name(a: A): R" }`.
- **`dependencies`**: each package you add, remove or bump in `package.json`: `{ "name": "p-retry", "change": "add", "range": "^6" }`.
- **`tests`**: each test you add, modify or remove: `{ "file": "src/x.test.ts", "name": "<describe titles> <test title>", "change": "add" }`. Weakening a test (deleting it, removing an assertion, adding `.skip`/`.only`/`.todo`, rewriting a snapshot, loosening a matcher) needs a `modify` or `remove` Clause naming it.
- **`mustNotChange`**: paths, `path#*` or `path#Name` the change leaves alone. Promise what reviewers care about.
- **`forks`**: decisions you made between options, with your rationale. Recorded for the reviewer, not checked.

CI and config files (`.github/**`, `tsconfig*.json`, lint configs, `.change-contract.json`) go in `scope.files` when the issue needs them changed.
