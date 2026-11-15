# The GitHub Action runs on pull_request_target, never pull_request

On a `pull_request` event, GitHub runs the workflow file from the PR's own merge commit. An Agent-authored PR could therefore edit the gate's workflow to skip the gate, or to report a passing `change-contract` check of its own. The ci-config Deviation would flag the edit, but only if the gate still runs.

On `pull_request_target`, GitHub runs the workflow from the base branch, with a token that can write. The gate's workflow, the Action version and the gate config (`.change-contract.json`) all come from the base branch. A PR can change them only by being merged.

`pull_request_target` is dangerous when a workflow runs code from the PR, because that code would get a write token. The gate never runs PR code. It fetches the PR's commits and reads files through git (`git show`, `git log`), and it parses TypeScript without executing it. The checkout stays on the base branch.

## Consequences

- The workflow must not check out the PR head into the working tree, or run install or build steps on it. The example workflow in `packages/action/README.md` checks out the base branch only.
- PRs from forks get a working token too, so the check and the summary comment work for them. The bot still can't push Approval Commits to a fork's branch, and says so.
- `issue_comment` events also run the default branch's workflow, so approvals and Sign-offs are handled the same way.
- The adapter refuses `pull_request` events outright, so a misconfigured workflow does nothing rather than run a gate the PR controls.
- **Open gap: look-alike checks.** `pull_request_target` protects the gate's own workflow, not the check's name. A PR from a branch in the repository can add a new `pull_request` workflow that posts a passing `change-contract` check. With `GITHUB_TOKEN`, that check comes from the same GitHub Actions app as the real one. The fix is to run the gate with its own GitHub App token, and to require the check from that app (`packages/action/README.md`). The default setup doesn't, so teams must opt in.
- PLAN.md §7 listed `pull_request`. This ADR replaces it.
