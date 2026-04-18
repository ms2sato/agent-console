# Context Store

This directory is a dynamic layer that sits alongside `docs/design/` (long-form design documents), `.claude/rules/` (always-loaded constraints), and `.claude/skills/` (condition-triggered procedures). It is the fourth layer in the project's knowledge architecture.

The design intent comes from the Sprint 2026-04-18 design discussion summarized in `docs/narratives/2026-04-18-brewing-pilot-founding.md`. In short: the CTO ("Orchestrator" in this project) is not only a dispatcher — it is also a *brewing device* that surfaces tacit knowledge into explicit, queryable artifacts over time. The Context Store is where those artifacts land.

## Currently populated

As of the brewing Pilot (2026-04-18 — 2026-05-02), only the brewing pipeline produces artifacts in this directory:

| Path | Purpose | Maintained by |
|---|---|---|
| `_proposals/` | Draft architectural-invariant proposals awaiting owner review | `brew-invariants.js` + the invoking Claude applying `.claude/skills/brewing/SKILL.md` |
| `_rejected/` | Proposals the owner declined, kept with reject reasons | Reviewer (owner or CTO) |
| `brewing-log.md` | Record of brewing decisions (skip / propose) on merged PRs | Orchestrator as step 7f of Post-Merge Flow |

The trigger and rubric for brewing are specified in:

- `.claude/skills/orchestrator/core-responsibilities.md` §7f (when)
- `.claude/skills/brewing/SKILL.md` (how to judge)

## Intentionally empty (Phase 2 candidates)

The original design framing (`docs/narratives/2026-04-18-brewing-pilot-founding.md`) anticipates additional Context Store artifacts once Phase 1 brewing mechanics are proven. Phase 2 candidates, identified by the conteditor CTO during the same Sprint:

- **Task-specific 参照 index** — "for this task, reference these existing implementations" (replaces manual grep during dispatch)
- **Decision Log** — "why this pattern was adopted" (ADR-style summaries that prevent re-deriving the same decision)
- **Worker 実績 profile** — "which agent is strong / weak at what" (informs dispatch routing)

These are *not* scaffolded yet. The Context Store grows only as brewing is validated and specific needs surface from real operation. The decision on whether to populate them is scheduled for 2026-05-02 (Pilot end review).

## Principles for future expansion

When adding a new artifact type to this directory:

1. Apply `.claude/rules/pre-pr-completeness.md` — the 4-question gap-scan.
2. Document the artifact's full lifecycle in a dedicated README within the new subdirectory.
3. Wire the trigger into the appropriate canonical procedure (`core-responsibilities.md`, `sprint-lifecycle.md`, or a new section if the trigger does not fit existing phases).
4. If the artifact requires a brewing agent, extend `.claude/skills/brewing/SKILL.md` with a sub-rubric rather than creating a parallel rubric file.

## What this directory is not

- **Not a replacement for `.claude/rules/` or `.claude/skills/`.** Rules are always-loaded prescriptions; skills are condition-triggered procedures. Context Store artifacts are dynamic data / queryable records that a judging Claude reads on demand.
- **Not a staging area for design documents.** Long-form design belongs in `docs/design/`. Context Store is for artifacts that evolve continuously and are queried per-task, not for one-shot design documents.
- **Not a task tracker.** In-flight work lives in GitHub Issues and `memory/project_sprint_status.md`, not here.
