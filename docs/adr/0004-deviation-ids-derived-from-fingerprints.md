# Deviation IDs are derived from the Deviation Fingerprint

A Sign-off names a Deviation by its display ID (`/signoff <id> accept "…"`). The gate keeps no state beyond the repo and the PR thread, so it can't store a table mapping each ID to the Deviation that was on screen when the reviewer signed off. The ID itself has to carry that identity.

So the display ID is `D` followed by the first 16 hex characters of the Deviation Fingerprint, for example `D3fa29c1e0b7d4a52`. A Sign-off stays valid exactly as long as some current Deviation still has that ID. If the Deviation's content changes, its fingerprint and ID change too, and the old Sign-off lapses without any further rule.

## Considered options

- **Sequential IDs (`D1`, `D2`, …) ordered by fingerprint.** These are friendlier to type. But a new Deviation renumbers the ones after it, so a Sign-off for `D2` could silently move to a different Deviation. Rejected.
- **A short fingerprint prefix (for example 6 hex characters).** This is too easy to forge. An agent could vary harmless content until a changed Deviation lands on an already-accepted ID: 6 hex characters is about 2^24 attempts. With 16 characters it would take about 2^64, which is out of reach.

## Consequences

- IDs are long. People copy them rather than type them: the summary table prints the exact `/signoff` command for each Deviation.
- The fingerprint formula is effectively public API: `sha256("<kind>/<check>\n<target>\n<content>")`, where the check (scope, ci-config, dependencies, must-not-change, …) refines the kind, and the content has its line endings unified and trailing whitespace removed. Changing the formula lapses every existing Sign-off, so any change needs a new ADR.
