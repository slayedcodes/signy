# Change Contract gate: GitHub Action

Runs the Change Contract gate on every pull request and reports it as a `change-contract` check run, plus one summary comment it keeps up to date. When a reviewer comments `/contract approve`, it records the Contract Approval by pushing an empty Approval Commit, then runs the gate on the new head. That has to happen in the same job, because pushes made with `GITHUB_TOKEN` start no workflow.

## Workflow

Add `.github/workflows/change-contract.yml` to the default branch:

```yaml
name: change-contract
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled]
  issue_comment:
    types: [created, edited]

permissions:
  contents: write       # push Approval Commits
  checks: write         # the change-contract check run
  pull-requests: write  # the summary comment and replies on the PR
  issues: write

# No `concurrency` group: GitHub keeps only one pending run per group and drops the rest,
# which could drop the run for a `/contract approve`. Overlapping runs are safe: the
# Approval Commit is never force-pushed, and every run catches up on a pending approval.

jobs:
  gate:
    if: github.event_name == 'pull_request_target' || github.event.issue.pull_request
    runs-on: ubuntu-latest
    steps:
      # The base branch only: the gate reads the PR through git and never runs its code (ADR 0005).
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: gate
        uses: slayedcodes/signy/packages/action@main
      - if: steps.gate.outputs.run-summary
        uses: actions/upload-artifact@v4
        with:
          name: change-contract-run-summary
          path: ${{ steps.gate.outputs.run-summary }}
```

Then make `change-contract` a required status check in the branch protection rules (or a ruleset) for the default branch.

## Protecting the check from look-alikes

Branch protection matches a required check by name, and optionally by the app that posted it. With `GITHUB_TOKEN`, the gate's check comes from the GitHub Actions app. An Agent-authored PR from a branch in this repository could add its own `pull_request` workflow that posts a passing `change-contract` check from the same app.

To close this, give the gate its own GitHub App:
1. Create an app with Contents (write), Checks (write), Issues (write) and Pull requests (read), and install it on the repository.
2. Mint its token with `actions/create-github-app-token`, and pass it as `github-token`.
3. In the branch protection rule, require `change-contract` *from that app*.
4. Set `bot` in `.change-contract.json` to the app's bot identity (`<app-slug>[bot]` and `<app-id>+<app-slug>[bot]@users.noreply.github.com`), because the app then signs the Approval Commits.

This also covers agents that run inside Actions with their own `GITHUB_TOKEN` (ADR 0003).

## Things to know

- **Use `pull_request_target`, not `pull_request`.** On `pull_request`, the workflow file comes from the PR itself, so an agent could edit it to skip the gate (ADR 0005). Don't add steps that check out, install or build the PR's code.
- **Approval Commits are created through the API**, so GitHub signs them as github-actions[bot]. The gate trusts only Approval Commits whose signature GitHub verified (ADR 0003).
- **The bot can't push to forks.** On a PR from a fork, `/contract approve` gets a reply asking for a branch in the repository.
- **Comments by bots are ignored**, so the summary comment can't trigger the gate again.
- **A comment's commands count as its last editor's.** Anyone with write access can edit anyone's comment, so `/contract approve` added to a reviewer's comment by someone else is that person's approval, and the Sign-off Policy judges them.
- **The comment that started a run gets a reply** for every command the gate couldn't act on: a refused approval, a malformed command, or a command on a PR the gate doesn't apply to.
- **The job's own result isn't the gate's verdict.** The verdict is the `change-contract` check run; the job fails only if the Action itself errors. Require the check, not the job.
- **Rewriting history drops the Approval Commit**, for example a force-push or a rebase onto a new base. The gate then fails until someone comments `/contract approve` again.
- **GitHub lists at most 250 commits for a PR**, and only listed commits count as verified. A longer PR fails the approval check.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token for the API. |
| `run-summary` | `change-contract-run-summary.json` | Where to write the run summary. |

| Output | |
|---|---|
| `status` | `pass`, `fail`, or `skipped` for events that aren't about a PR, or that came from a bot. |
| `run-summary` | Path of the run summary, when the gate ran. |

## Building

`pnpm --filter @change-contract/action build` bundles `src/main.ts` into `dist/index.cjs`. The bundle is committed, because an Action runs from the repository as it is.
