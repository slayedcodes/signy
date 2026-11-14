# Host-neutral core with thin per-host adapters

The gate's logic lives in a host-neutral TypeScript core and CLI: contract validation, Deviation detection, Sign-off parsing and policy evaluation. Each code host (GitHub first) gets a thin adapter that only fetches PR data, reads comments and reports a check status. We chose this over a GitHub-native Action because the tool must work with any Producing Agent and on more than one code host, and because the code host may be one we don't control. Moving the logic into a GitHub Action later would be cheap. Pulling it back out would not.

## Consequences

- Sign-offs and Contract Approvals are comment commands, not GitHub-specific UI such as check-run buttons. Every host has comments.
- No state is stored outside the repo and the PR thread.
