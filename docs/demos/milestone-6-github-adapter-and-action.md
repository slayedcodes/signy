# Milestone 6: GitHub adapter and Action

The gate now runs as a GitHub Action, `packages/action`. It handles `pull_request_target` and `issue_comment` events through the adapter, `packages/adapter-github`:
- **Check:** it posts a `change-contract` check run on the PR head.
- **Summary comment:** it keeps one summary comment up to date.
- **Approvals:** it turns `/contract approve` into an Approval Commit.
- **Replies:** it answers every command it can't act on.

`packages/action/README.md` has the workflow to copy, and the setup that keeps the check from being faked.

## How it works

1. **Event.**
   - `pull_request_target` and `issue_comment` on a PR are handled.
   - `pull_request` is refused, because the PR controls that workflow file (ADR 0005).
   - Comments by bots are ignored, so the summary comment can't loop.
2. **Gate input.**
   - **From GitHub:** the PR, its comments, and each commenter's permission (`role_name`, so `maintain` and `triage` are told apart).
   - **From git:** the commits. The PR head is fetched through `refs/pull/N/head`, and the checkout stays on the base branch.
   - **Signatures:** GitHub's verification of each commit is passed to the core, so `hostVerifiesSignatures` is set.
   - **Edits:** a comment's commands count as its **last editor's** (GraphQL `editor`), because anyone with write access can edit anyone's comment.
3. **Approval.** The first comment whose `/contract approve` the core's `prepareApproval` accepts becomes an Approval Commit. The triggering comment is tried first, then the others, newest first, so a dropped run is caught up on the next event. The approval is refused, with a reply, in these cases:
   - the approver isn't allowed by the Sign-off Policy
   - the hash isn't the current Contract Version
   - code is already on the branch
   - the branch is in a fork
4. **Push.** The adapter creates the commit through the API, with the head's tree, the head as parent, and no author, so GitHub signs it as github-actions[bot]. It then fast-forwards the branch without forcing it. If someone pushed in between, it replies "comment again".
5. **Gate.** The gate runs on the new head in the same job, because pushes made with `GITHUB_TOKEN` start no workflow.
6. **Report.**
   - A check run with conclusion `success` or `failure`.
   - The summary comment, updated in place (a PR the gate doesn't apply to gets none).
   - Replies to the triggering comment's command errors.
   - `run-summary.json` as an output, for `actions/upload-artifact`.

New core rule: `approval-not-verified`. When the host reports signatures, the gate trusts only an Approval Commit the host verified. ADR 0003 was amended: a verified signature plus ancestry orders approval before code, so push times aren't needed. Your decision.

## Sandbox demo

A private repo, `slayedcodes/signy-sandbox`, uses the workflow from the README with `slayedcodes/signy/packages/action@main`. It has one human account, so `.change-contract.json` sets `signoffPolicy.allowPrAuthor: true`. PR #1 is on branch `claude/say-hi`, which the agent branch pattern marks as an Agent-authored PR.

| Step | Result |
|---|---|
| Push the Contract Commit and open PR #1 | The run failed with `403 Resource not accessible by integration` when posting the summary comment. The README asked for `pull-requests: read`, but commenting on a PR needs `pull-requests: write`. **Fixed** in the README and the sandbox. |
| Comment `/contract approve` | The bot pushed `7863d72 Approve Change Contract say-hi`. GitHub lists it as authored by github-actions[bot] with `verification.verified: true` (`valid`), confirming ADR 0003's assumption. `change-contract` passed, and the summary comment was posted. |
| Push the code: `greet` changed, plus a new `src/farewell.ts` | `change-contract` failed with one Unplanned Change, `src/farewell.ts` (`D8939828e4808adf2`). The run summary artifact was uploaded. |
| Comment `/signoff D8939828e4808adf2 accept "…"` | `change-contract` passed. The run summary records 1 Deviation, 1 accepted Sign-off and an approval latency of 53 s. |
| After the fix below: comment `/contract aprove` | The bot replied `> /contract aprove` / `@slayedcodes Unknown command. The gate understands …`, and updated the existing summary comment in place, without adding another. |

**Bug found by the demo, and fixed:**
- **What happened:** the last run posted a *second* summary comment instead of updating the first.
- **Why:** GraphQL names a bot editor `github-actions`, while REST says `github-actions[bot]`. Once the bot had edited its own comment, the adapter took it for a comment edited by someone else, so it was no longer the bot's.
- **Fix:** the adapter now asks for `__typename` and adds `[bot]` for bots.
- **Checked against GitHub:** a GraphQL query on the sandbox returned `{"__typename":"Bot","login":"github-actions"}`.
- **Test:** `still recognizes its summary comment after editing it` reproduces it.

## Tests

- **Adapter (`handleEvent`, 18 tests).** A fake `fetch` answers from `test/recorded/`, and a real fixture repo provides git. Creating a git commit through the fake really creates it, as `github-actions[bot]`, so the gate can read it. The tests cover:
  - an approved PR passing
  - pushing an Approval Commit
  - refusals: PR author, hash, code first, fork
  - an approval that's already recorded
  - catching up on an approval
  - a branch that moved during approval
  - an Approval Commit without a verified signature
  - `role_name` permissions
  - a PR the gate doesn't apply to
  - updating the summary comment in place
  - a comment the bot itself edited
  - commands from a comment's editor
  - replies to malformed commands
  - ignoring bots
  - refusing `pull_request`
- **Gate fixtures:** `approval-commit-verified` and `approval-commit-unverified`.

**Test-first:**
- **Seen failing before their code:**
  - the first adapter test
  - the approval push
  - not applicable
  - the six review fixes: `pull_request`, editor, catch-up, branch moved, malformed command, commands on a PR the gate doesn't apply to
  - the edited summary comment
  - `approval-commit-unverified`
- **Passed as soon as written** (they pin behaviour): the policy refusal, bots ignored, update in place, unverified, `role_name`, already approved, fork, and hash or code refusals.

**Recorded responses** are written by hand from GitHub's documented shapes, not captured, apart from the GraphQL shape checked against the sandbox. The demo is what confirmed the real behaviour: API signing, the `403` for PR comments, and bot logins in GraphQL.

## Fixed after code review

- **Edited comments:** commands count as the last editor's, so editing a reviewer's comment can't forge an approval or a Sign-off.
- **Lost approvals:**
  - The README's `concurrency` group could drop the run for `/contract approve`. The group is removed, and every run now catches up on a pending approval.
  - A branch that moves during the push gets a reply instead of an error.
- **`pull_request` is refused,** as ADR 0005 says.
- **Replies (§6):** malformed commands, and commands on a PR the gate doesn't apply to, now get a reply instead of only a mention in the summary.
- **Look-alike checks:** documented in ADR 0005 and the README. Any workflow using `GITHUB_TOKEN` posts checks as the same GitHub Actions app. The fix is a dedicated GitHub App token, with the required check pinned to that app.
- **Smaller fixes:**
  - `ApprovalPlan` is now `ApprovalDecision`, since "Plan" is an avoided word.
  - A shared `commitsAfter` helper.
  - `fetchCommits` is renamed.
  - A `GitHubConnection` type.
  - Branch names are encoded in the refs API path.
  - `fileURLToPath` in the build script.

## Open items

- **Look-alike checks:** with the default `GITHUB_TOKEN` setup, another workflow can post a passing `change-contract` check. Teams must opt in to a GitHub App, as described in the README.
- **The 250-commit limit:** GitHub lists at most 250 commits for a PR, so an Approval Commit beyond that counts as unverified.
- **Forks:** PRs from forks can't be approved; the bot can't push to them.
- **No catch-up for a dropped Sign-off run:** a Sign-off is read on every run, so it takes effect on the next event, but nothing re-runs the gate if its own run was lost.
- **The sandbox's leftover comment:** PR #1 still has the duplicate summary comment from before the fix.
- **The job's result isn't the gate's verdict:** the required check must be `change-contract`, not the job.
