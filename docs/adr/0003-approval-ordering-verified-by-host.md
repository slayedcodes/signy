# Approval ordering is verified with the code host's records

The gate's core can prove that an allowed human approved the exact Contract Version: the Approval Commit's trailers must match a real `/contract approve` comment. What it can't prove from git alone is *when* that approval happened relative to the code. Commit authors and dates are fields anyone can set. So an agent could write code, wait for the approval, then rewrite history so the Approval Commit (or a copy of it) sits in front of code that existed before the human approved.

We close this gap in the host adapter, not the core. On GitHub the adapter checks two things. First, the Approval Commit carries a signature the host verified for the gate bot. Second, the approval comment's timestamp is earlier than the host's own record of when each code commit after the Approval Commit was pushed. The host's push records can't be rewritten by the agent. The core stays host-neutral (ADR 0001), and it reports the facts the adapter needs.

## Considered options

- **Trust commit dates.** Rejected: they're set by whoever makes the commit.
- **Forbid force-pushes on agent branches.** This is useful hardening that teams can turn on, but it's a branch setting outside the gate, so the gate can't rely on it.
- **Store approved commit hashes outside the repo.** When the bot pushes an Approval Commit, it would also record that commit's SHA and the SHAs of the commits before it in storage the agent can't write to. The gate would then verify against that record, on any host. This is the most robust option, but it breaks the "no state beyond the repo and the PR thread" decision (PLAN.md §2), so it's deferred. Revisit it if a host can't supply trustworthy push records, or if we add a second adapter.

## Consequences

- Until milestone 6 lands, a determined agent can replay an approval. The demo notes say so.
- Each adapter must supply push or signature data, so adapters are less thin than ADR 0001 implies.
- If we later adopt the external store, it would supersede this ADR and amend the State decision in PLAN.md §2.
