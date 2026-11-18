# Milestone 7: CLI init, approve and feedback, and the Claude Code plugin

## CLI

| Command | For | Does |
|---|---|---|
| `contract init --issue <url\|text> [--summary] [--slug] [--scope]…` | Producing Agent | Scaffolds `.contracts/<slug>.json` from a template. On a terminal it asks for anything missing; without one it names the flags to pass. It checks the slug (lowercase words joined by hyphens), never overwrites, and never commits. |
| `contract approve [--pr] [--repo]` | reviewer | Posts `/contract approve sha256:<hash>` with the reviewer's own token. The hash is the Contract Version the gate checks: the Change Contract that commit 1 adds. It refuses when commit 1 adds no Change Contract, or the Change Contract changed after commit 1. |
| `contract feedback [--pr] [--repo]` | Producing Agent | Runs the gate on the PR, with its comments and Sign-offs, and prints what to do: failures, rejected Deviations with the reviewer's reason, and unsigned Deviations. Before the Contract Approval it says to wait instead. It never posts. Exit 0 means nothing to do, 1 means something to do, 2 means it couldn't run. |

`approve` and `feedback` find their target like this:
- **Token:** `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`.
- **Repo:** `--repo`, otherwise the origin remote.
- **PR:** `--pr`, otherwise the open PR for the checked-out branch.

They go through the GitHub adapter, as PLAN §8 says. ADR 0001 now records that these two are the CLI's host commands, and that the gate commands (`init`, `validate`, `check`) stay host-neutral.

## Plugin

- `.claude-plugin/marketplace.json` lists the `change-contract` plugin. Install it with `/plugin marketplace add slayedcodes/signy`, or `claude plugin marketplace add slayedcodes/signy`.
- `plugins/change-contract/skills/change-contract/SKILL.md` follows PLAN §9's six steps, each with a "done when". The skill fires on its own in repos with `.contracts/` or `.change-contract.json`.
- `plugins/change-contract/bin/contract.cjs` is the CLI bundled for plain `node`, so nothing is published to npm (your decision). Build it with `pnpm --filter @change-contract/cli build:plugin`.
- `claude plugin validate` passes for the marketplace and for the plugin.

## Clean-environment demo

**Setup:**
- **Config:** a fresh `CLAUDE_CONFIG_DIR` holding only a copy of the login credentials, deleted afterwards. No other plugins or settings.
- **Install:** `claude plugin marketplace add slayedcodes/signy`, then `claude plugin install change-contract@change-contract`.
- **Repo:** a fresh clone of the private `slayedcodes/signy-sandbox`.
- **Agent:** headless `claude -p`. Its tools were allowed by name; it got no instructions about the skill.

| Step | What happened |
|---|---|
| **Agent session 1.** Prompt: *"Add a shout(name) function to src/greet.ts that returns the greeting in upper case… Open a PR for it on GitHub."* | The skill fired on its own. The agent:<br>- made branch `claude/shout-greeting`<br>- drafted `.contracts/shout-greeting.json` with symbol scope `src/greet.ts#shout`, an interface Clause `shout(name: string): string`, `mustNotChange: src/greet.ts#greet`, and a recorded fork<br>- committed it alone and opened **draft** PR #2<br>- stopped and asked for the Contract Approval<br>That took 19 turns and $0.67. `change-contract` failed with `approval-missing`. |
| **Reviewer.** `contract approve`, with no flags, in the checkout | It found `slayedcodes/signy-sandbox#2` from the branch and the origin remote, and posted `/contract approve sha256:6b29…`. The gate pushed `65d1b02 Approve Change Contract shout-greeting`, authored by github-actions[bot] and verified. |
| **Agent session 2.** Resumed with *"The Change Contract is approved. Go ahead."* | The agent pulled the Approval Commit and added `shout` on top of it, calling `greet(name).toUpperCase()`. It ran `contract check`, pushed, and marked the PR ready. That took 9 turns and $0.15. |
| **Gate** | Commits on the PR, in order:<br>1. Change Contract<br>2. Approval Commit<br>3. code<br>`change-contract` passed with no Deviations, since the agent stayed within its Change Contract. |
| **`contract feedback`** on the checkout | "The Change Contract gate passes on slayedcodes/signy-sandbox#2. Nothing to rework." Exit 0. |

The demo didn't exercise a Deviation and Sign-off, because the agent stayed in scope. The milestone 6 demo (PR #1) covered that path, and the `feedback` tests cover rejected and unsigned Deviations.

## Tests

- **`contract init`, 8 tests:**
  - subprocess: text issue, link issue, missing flags, bad slugs, empty summary, no overwrite
  - in-process: terminal prompts
- **`contract approve` and `contract feedback`, 9 tests,** in-process with `main(args, io)`, an injected `fetch` replaying recorded responses through the adapter's fake GitHub, and a real fixture repo:
  - approve: posts the hash; finds the PR and repo from the checkout; refuses a Change Contract changed after commit 1; refuses when commit 1 adds none; needs a token
  - feedback: rejected and unsigned Deviations; waiting for the Contract Approval; exit 2 when it can't run; nothing to rework

**Test-first:** every test was seen failing before its code.

The decision was "subprocess for init and feedback", but `feedback` is tested in-process: it needs the injected `fetch`, which a subprocess can't take. The live demo ran the bundled CLI as a subprocess.

## Fixed after code review

- **`approve` hashed the wrong version.** It hashed the Change Contract at the PR head; it now hashes the Contract Version from commit 1. A Change Contract edited later gets a refusal instead of a comment the gate would reject.
- **`init` took any slug:** `../x` wrote outside `.contracts/`, and `!!!` wrote `.contracts/.json`. It also crashed on `--summary ""` without a terminal. Both are fixed.
- **`feedback` misled the agent:**
  - before the Contract Approval it said "rework"; it now says "wait"
  - it used exit 1 for errors, the same as "rework"; errors now exit 2
  - it suggested a local base branch; it now suggests `origin/<base>`
- **SKILL.md:**
  - every step has a completion criterion
  - the CLI path is quoted
  - the push is `git push -u`
  - it says plainly that the Change Contract stays as approved, and that a new Contract Version means a new PR
  - it uses glossary terms throughout
- **Placeholder URL:** the schema's `$id` and `init`'s `$schema` no longer use the placeholder npm URL; they point at the schema in this repository.
- **Smaller fixes:**
  - one shared runner for the PR commands
  - `isContractFile` moved into the core
  - unused API methods removed

## Open items

- **Fork clones:** `feedback` fetches missing commits from `origin`. In a fork clone where `origin` is the fork, pass a checkout that has the PR's commits.
- **GitHub Enterprise:** `approve` and `feedback` read `owner/name` from a `github.com` remote only; on Enterprise, pass `--repo`.
- **Bundle size:** the bundled CLI is about 10 MB, mostly TypeScript. The Action has a second copy.
