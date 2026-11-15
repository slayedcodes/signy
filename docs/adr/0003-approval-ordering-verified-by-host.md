# Approval ordering is verified with the code host's signature on the Approval Commit

The gate's core can prove that an allowed human approved the exact Contract Version: the Approval Commit's trailers must match a real `/contract approve` comment. What it can't prove from git alone is that the gate bot made the Approval Commit. Commit authors and dates are fields anyone can set. So an agent could write its own "Approval Commit" with the bot's name, and place it wherever suits it.

We close this gap with a fact only the code host can supply. On GitHub the gate bot creates the Approval Commit through the API with `GITHUB_TOKEN`, and GitHub signs it. The adapter reports which commits GitHub verified, and the core then trusts only a verified Approval Commit (rule `approval-not-verified`). The core stays host-neutral (ADR 0001): it reads a `signatureVerified` fact per commit, and an adapter that can't supply one leaves the check off.

Ordering then follows from ancestry, which the core already checks. Every code commit must descend from the Approval Commit, and a commit can only name a parent that already exists. The verified Approval Commit exists only once the bot has made it, after reading the approval comment. So every code commit was made after the Contract Approval.

## Considered options

- **Trust commit dates.** Rejected: they're set by whoever makes the commit.
- **Also compare push times with the approval comment.** This was the original plan for this ADR: read the host's push records (on GitHub, the repository Activity API) and require every code commit to have been pushed after the approval comment. Dropped in milestone 6. Given a verified Approval Commit and ancestry, it adds nothing: a code commit descending from the Approval Commit can't have been pushed before it existed. It would also cost an extra API dependency with limited retention.
- **Forbid force-pushes on agent branches.** This is useful hardening that teams can turn on, but it's a branch setting outside the gate, so the gate can't rely on it.
- **Store approved commit hashes outside the repo.** When the bot pushes an Approval Commit, it would also record that commit's SHA and the SHAs of the commits before it in storage the agent can't write to. The gate would then verify against that record, on any host. This is the most robust option, but it breaks the "no state beyond the repo and the PR thread" decision (PLAN.md §2), so it's deferred. Revisit it if a host can't sign commits for the bot, or if we add a second adapter.

## Consequences

- `contract check` runs locally without host data, so locally a forged Approval Commit isn't detected. The demo notes say so.
- **Signing on GitHub:**
  - The adapter must create Approval Commits through the API, never with `git push`, because only API commits get GitHub's signature.
  - It must not set an author on them, so GitHub authors them as the token's identity.
- An agent whose own workflow holds a `GITHUB_TOKEN` with `contents: write` could also make verified github-actions[bot] commits. It still can't fake the trailers' approval comment, and code must still descend from the approval. Teams that run agents inside Actions should give the gate its own GitHub App identity (`bot` in the gate config).
- If we later adopt the external store, it would supersede this ADR and amend the State decision in PLAN.md §2.
