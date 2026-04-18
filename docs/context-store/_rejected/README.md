# Context Store — Rejected Proposals

Brewing proposals that owner / CTO decided **not** to promote into the `architectural-invariants` catalog.

## Why keep them

Reject reasons document "why this pattern is NOT an invariant" — this is itself a form of formalized judgment. Future brewing runs should grep this directory to avoid re-proposing the same pattern from a different PR.

## Lifecycle

1. A proposal lives in `../_proposals/` awaiting review.
2. Reviewer decides to reject.
3. Reviewer moves the file here (`mv ../_proposals/<file> ./`) and appends:
   ```markdown
   ---
   ## Reject Reason

   _Rejected by: <reviewer> on YYYY-MM-DD_

   <1-3 sentences: what specifically disqualified this as an invariant.
   Reference the 4 catalog criteria (cross-cutting / high-leverage /
   named failure / concrete incident) where applicable.>
   ```

## Anti-pattern

**Never delete rejected entries.** Deletion loses the signal that prevents re-proposal. If the reason becomes obsolete (e.g., the pattern later warrants inclusion after all), annotate with `## Retracted Rejection` rather than deleting.
