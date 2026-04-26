# Glossary Maintenance

`docs/glossary.md` is the canonical source of project terminology. When new domain concepts are introduced, the glossary must be updated **in the same PR** that introduces the concept. This rule defines triggers, roles, and the drift-handling decision tree.

## Why this rule exists

LLM self-review is structurally weak at terminology drift detection. Without an explicit rule + acceptance-check question, the glossary will rot (terms drift, aliases proliferate, contradictions accumulate). This rule converts terminology integrity from "the Orchestrator notices it sometimes" to a mechanical check.

## Triggers — update `docs/glossary.md` when the PR

1. **Adds a new design doc** under `docs/design/` that introduces a new domain concept
   - Example: adding `docs/design/job-queue.md` with a new `Job` concept → add a `### Job` entry to glossary
2. **Adds a new type or interface** that represents a domain concept
   - Example: `packages/shared/src/types/job.ts` exporting `interface Job` → glossary entry
   - Counter-example: `packages/server/src/lib/format-utils.ts` internal helper types → not a glossary trigger
3. **Adds a new database schema field** representing a domain concept (not just a column rename)
   - Example: migration adding `sessions.assignee_id` → glossary entry for `assignee_id`
   - Counter-example: migration adding `created_at` index → not a glossary trigger
4. **Adds a new API endpoint or MCP tool parameter name** that names a domain concept
   - Example: `POST /api/sessions { initiated_by }` field → glossary entry for `initiated_by`
   - Example: `delegate_to_worktree({ assignee })` parameter → glossary entry for `assignee`
5. **Modifies an existing design doc's Terminology section** (added, renamed, or revised entries)
   - Example: `multi-user-shared-setup.md` Terminology section gains `Service User` → mirror in glossary
6. **Adds a new rule, skill, or narrative** under `.claude/rules/`, `.claude/skills/`, or `docs/narratives/` that **references a project-wide concept**
   - Example: a new rule mentioning `SharedSession` for the first time across rules → ensure glossary has `SharedSession` (it does — verify the rule's usage matches)
   - Counter-example: a rule mentioning a CLI flag (`--no-verify`) → not a glossary trigger

If the change does not match any trigger above, glossary update is not required.

## Roles

| Role | Responsibility |
|---|---|
| **PR author (primary)** | Identify whether their PR matches a trigger above and update `docs/glossary.md` in the same PR |
| **Orchestrator (confirmer)** | During acceptance check, mechanically verify glossary integrity via `acceptance-check.js` Q9. If missing, request the agent add the entry before merge |
| **Owner** | Not in the review path. Drift surfaced by owner is a process failure of PR author + Orchestrator |

## Drift-handling decision tree

When the Orchestrator (or PR author during self-check) finds a term in the codebase or documentation that does not appear in `docs/glossary.md`:

1. **Is the term in scope of this PR's changes?**
   - **Yes** → Add the entry to `docs/glossary.md` in this PR. Do not defer.
   - **No** (the term predates the PR) → Continue.
2. **Is the term used by code or docs the PR is modifying?**
   - **Yes** → Add the entry in this PR (the PR surfaces the gap; the same PR closes it).
   - **No** (the term appears only in unrelated parts of the repo) → File a follow-up issue tagged `glossary-drift`. Do not block the PR.
3. **Is the term a renamed / drifted variant of an existing glossary entry?**
   - **Yes** → Update both the glossary entry's `Aliases` field and rename in the affected files in this PR.
   - **No** → Treat as a missing entry per step 1 or 2.

The same decision tree applies when finding contradictions (e.g., two entries describing the same concept with different definitions).

## Cross-references

- **Canonical source**: [`docs/glossary.md`](../../docs/glossary.md) (Maintenance section also summarizes triggers; this rule is the operational expansion)
- **Acceptance check**: `acceptance-check.js` Q9 — Orchestrator's mechanical verification step during PR review
- **Sibling rule**: [`pre-pr-completeness.md`](pre-pr-completeness.md) — covers process completeness for new mechanisms; this rule is adjacent (terminology) and orthogonal (Gap-Scan does not include glossary checks)
- **Future automation**: Issue [#671](https://github.com/ms2sato/agent-console/issues/671) — referenced-but-not-defined linter (separate concern, this rule remains the manual gate until the linter lands)

## How this rule is expected to evolve

When the Issue #671 linter lands, the Orchestrator's manual Q9 check can be downgraded from "mechanical verification step" to "spot-check fallback" since the linter will detect missing entries in CI. Until then, apply Q9 mechanically rather than skipping on the assumption that the agent already updated the glossary.
