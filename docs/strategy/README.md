# docs/strategy/

Project-level strategic posture documents — the **prescriptive** counterpart to `docs/narratives/` (which is descriptive / phenomenological).

## Purpose

These documents define **what the project is, what it refuses to become, and what shapes a go / no-go judgment**. They are referenced by the Orchestrator (`.claude/skills/orchestrator/core-responsibilities.md §1`) before making prioritization decisions.

## Files

- `strategy-overview.md` — Mission, positioning, core design principles, prioritization lens, open questions. Read this first.

## Relationship to other knowledge layers

| Layer | Role |
|---|---|
| `docs/strategy/` | **Prescriptive** — what to do and what not to do at the strategic level |
| `docs/narratives/` | **Descriptive** — why the prescriptions exist, the situated experience that produced them |
| `.claude/rules/` | **Operational constraints** — always-loaded rules that apply to every change |
| `.claude/skills/` | **Procedural** — triggerable skills that guide specific activities |

When strategy and rules appear to conflict: strategy is the higher-order ground. Update the rule or raise the conflict in a retrospective — do not silently override.

## Evolution

- Small wording refinements happen in-place via a normal PR.
- **Core principle shifts require an accompanying narrative entry** in `docs/narratives/` capturing the insight that drove the shift. A strategy change without a narrative is incomplete.
- Additions follow the same pattern: narrative-first (the insight), then prescriptive addition here.

## Stability policy

Strategy documents should change infrequently and only with clear motivation. A high churn rate is a sign that the articulation is not yet stable — investigate rather than keep editing.
