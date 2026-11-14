# Contract Approval is recorded as a bot-authored Approval Commit

A human approves a contract by commenting `/contract approve`. The gate bot then pushes an empty Approval Commit to the PR branch. Its trailers carry the contract hash, the approver and the comment URL. We chose this over trusting a comment alone or a locally made commit, for two reasons. First, "approved before any code was written" then holds by construction, because code commits must come after the Approval Commit. Second, the agent can't forge an approval: the gate trusts an Approval Commit only when the configured bot identity authored it and a real comment from an allowed human with the same hash exists.

## Consequences

- The bot needs push access to PR branches, including those from forks if you support them.
- On GitHub, commits pushed with `GITHUB_TOKEN` don't trigger workflows. The approval workflow must therefore run the gate itself after it pushes.
- If the branch is rewritten and the Approval Commit is lost, approval is lost too and the gate fails.
