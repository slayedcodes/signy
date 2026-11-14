# Milestone 2: Structure and approval

`runGate` now runs steps 1–3 of PLAN.md §5. Every check runs and every failure is collected, and each failure names the exact rule that failed. Steps 4–7 (Deviations and Sign-offs) come in later milestones. Until then, an approved, well-formed Agent-authored PR passes.

## Rules

| Step | Rule | Fails when |
|---|---|---|
| 1 | *(detection)* | Never fails. It decides whether the gate applies. The `contract:required` label forces the gate on, and `contract:exempt` forces it off. If both labels are present, `contract:required` wins. Otherwise, any one of these rules is enough to make the PR agent-authored: a known agent account as PR author, a `Co-Authored-By` trailer naming a known agent, an agent label, or an agent branch pattern. |
| 2 | `contract-missing` | No commit in the PR adds a `.contracts/*.json` file. The message points to `contract init`. |
| 2 | `contract-commit-empty` | Commit 1 adds no Change Contract, but a later commit does. |
| 2 | `contract-commit-multiple` | Commit 1 adds more than one Change Contract. |
| 2 | `contract-commit-extra-files` | Commit 1 changes anything besides the Change Contract. |
| 2 | `contract-changed-later` | A later commit adds, deletes or edits any file under `.contracts/`, including contracts from earlier PRs. |
| 2 | `contract-invalid` | The contract isn't valid JSON, fails the schema or lint, or its slug doesn't match its file name. |
| 3 | `approval-missing` | There is no valid Approval Commit. |
| 3 | `approval-after-code` | A commit with file changes comes before the valid Approval Commit. |
| 3 | `approval-not-bot` | A commit claims to be an Approval Commit, but the configured bot identity didn't author it. |
| 3 | `approval-not-empty` | An Approval Commit changes files. |
| 3 | `approval-trailers` | An Approval Commit lacks `Contract-Hash`, `Approved-By` or `Approval-Comment`. |
| 3 | `approval-hash-mismatch` | `Contract-Hash` isn't the hash of the contract in the Contract Commit. |
| 3 | `approval-comment-missing` | No comment on the PR has the URL given in `Approval-Comment`. |
| 3 | `approval-comment-author` | The cited comment's author isn't the `Approved-By` login. Logins are compared case-insensitively. |
| 3 | `approval-comment-command` | The cited comment has no `/contract approve` for the approved hash. |
| 3 | `approver-not-allowed` | The Sign-off Policy refuses the approver. Bots are always refused. By default the PR author is refused, and so is anyone without admin, maintain or write permission. |

A commit counts as an attempted Approval Commit if the bot authored it or if it carries a `Contract-Hash` trailer. Other trailers, such as a team's own `Approved-By` convention, don't count. Every attempt is verified, and an invalid one fails the gate even when a valid one also exists.

Commits are read in commit-graph order (`git log --topo-order`), not by commit date, because anyone can set commit dates.

The contract hash is `sha256:` followed by the SHA-256 of the Change Contract's exact bytes at the Contract Commit.

## Config

```jsonc
{
  "agentDetection": {
    "agentAccounts": ["copilot-swe-agent[bot]", "devin-ai-integration[bot]", "cursor[bot]", "claude[bot]", "codex[bot]"],
    "coAuthorAgents": ["claude", "copilot", "cursor", "devin", "codex", "aider", "gemini", "jules"],
    "labels": ["agent-authored"],
    "branchPatterns": ["claude/*", "copilot/*", "cursor/*", "codex/*", "devin/*"],
    "requireLabel": "contract:required",
    "exemptLabel": "contract:exempt"
  },
  "signoffPolicy": { "permissions": ["admin", "maintain", "write"], "allowPrAuthor": false }
}
```

Those are the defaults. A team's config replaces each key it sets; lists are replaced, not merged. Loading this config from the repo is adapter work, so it comes in milestone 6.

## Fixtures

Each rule has at least one failing fixture, and the passing paths have their own fixtures too. In total there are 36 fixtures under `fixtures/`, including:
- approval before code vs after code
- forged approvals: wrong author, no comment, comment mismatch, missing trailers, an approval commit that isn't empty, a stale hash
- approval by the PR author, a read-only user and a bot, plus one where the policy allows the PR author
- two contracts in commit 1, or none
- a contract edited, replaced or added after approval, or an older contract edited

```console
$ pnpm test
 Test Files  3 passed (3)
      Tests  50 passed (50)
```

Fixtures support three placeholders. In `fixture.json` and `expected.json`, `{{contractHash}}` becomes the hash of the PR's contract. In `expected.json` only, `{{sha:N}}` and `{{short:N}}` become the SHA, full or short, of PR commit N.

## Open items

- **Approval replay (needs a design decision).** The bot's identity is matched on the git author name and email, which anyone can set. So the proof of approval is the comment match: an allowed human approved this exact hash. But that doesn't prove *when* the approval happened relative to the code. Suppose an agent pushes contract → code, and a reviewer then approves, so the bot's Approval Commit lands after the code. The gate fails correctly. The agent can then rewrite history to contract → Approval Commit (or a copy of it) → code, and the gate passes, even though the code existed before the human approved. Commit dates can't settle the order because they can be faked. Possible fixes:
  - in milestone 6, have the adapter confirm that the host verified the bot's signature on the Approval Commit, and that the comment's timestamp is earlier than the host's push time for every code commit
  - forbid force-pushes on agent branches
- **Merge commits (needs a design decision).** `readCommits` lists no files for merge commits. So a merge could change `.contracts/` or bring in code without the structure or approval-order rules seeing it. One option is to fail any Agent-authored PR that contains a merge commit. The other is to diff each merge against its first parent; then merging the base branch would count as code, and any contracts from other PRs it brings in would trip `contract-changed-later`.
- **Not in the spec, so please confirm:**
  - the `slug-matches-file` lint rule (§4 lists only three lint rules)
  - `contract:required` winning when both override labels are present
- **Anyone who can apply labels can apply `contract:exempt`.** The gate stores no state, so it can't tell who added a label. Teams that need to can restrict label permissions on the host.
- **The default `agentAccounts` logins are a best guess.** Check them during the pilot (milestone 8).
- **Malformed `/contract approve` lines are currently ignored.** §6 requires a reply explaining the syntax, which arrives with comment handling in milestones 3 and 6.
