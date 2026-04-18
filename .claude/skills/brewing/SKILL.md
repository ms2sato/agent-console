---
name: brewing
description: Evaluate a merged PR against the architectural-invariants catalog and propose a new invariant entry when warranted. Use when the Orchestrator (or a delegated sub-agent) is surveying a recent PR for cross-cutting patterns that the existing catalog does not cover.
---

# Brewing: Architectural Invariant Proposal Rubric

This skill is the rubric for **醸造 (brewing)** — the process of surfacing new cross-cutting architectural invariants from the evolving codebase.

A brewing session takes a single merged PR, asks *"did this PR reveal a class of bug or constraint that should be captured as a new I-N entry?"*, and either writes a draft proposal or records a skip.

## When to invoke

**Pilot period (2026-04-18 — 2026-05-02):** Run brewing after **every merged PR** in agent-console, as step **7f** of the Orchestrator's Post-Merge Flow (see `.claude/skills/orchestrator/core-responsibilities.md` §7f). This is the current operational contract.

**Outside the Pilot window**: TBD. At Pilot end (2026-05-02), owner and Orchestrator evaluate `docs/context-store/brewing-log.md` and `_proposals/` acceptance rate, then decide: continue as-is, tighten / loosen frequency, or retire.

**Not applicable**:
- PRs that never reach main (closed / abandoned) — skip entirely
- Horizontal deployments outside agent-console (e.g., conteditor) — have their own Pilot design, not yet underway

## Role separation

| Component | Role |
|---|---|
| `brew-invariants.js` | **Context packager only.** Fetches PR metadata, diff, linked Issue. No LLM call. |
| This SKILL.md | **Judgment rubric.** Read by the invoking Claude before writing a proposal. |
| The invoking Claude (Orchestrator or sub-agent) | **Judge.** Applies this rubric to the packaged context. |
| `.claude/skills/architectural-invariants/SKILL.md` | **Reference catalog.** Read by the judge to compare against existing invariants. |
| `docs/context-store/_proposals/` | **Output target.** Where accepted-as-candidate proposals land. |
| Owner / CTO | **Final approver.** Merges accepted proposals into the catalog, or moves them to `_rejected/`. |

## Inputs

Running `node .claude/skills/orchestrator/brew-invariants.js <PR>` prints:

1. PR metadata (title, body, URL, merge timestamp, author)
2. Linked Issue body (if the PR body contains a `closes #NNN` / `fixes #NNN` reference)
3. PR diff (truncated to 500 lines; full diff available via `gh pr diff <PR>`)

The judge must additionally read:

- `.claude/skills/architectural-invariants/SKILL.md` — the current catalog
- Existing files in `docs/context-store/_proposals/` and `docs/context-store/_rejected/` — to avoid re-proposing the same pattern

## Decision rubric

Adopted from the catalog's own "How to Add New Invariants" section.

**Propose a new invariant only if ALL four hold:**

1. **Cross-cutting.** The pattern applies across files, packages, or domains — not specific to one feature. A fix that only matters at one exact call site does **not** qualify.
2. **High-leverage detection.** Knowing the pattern transforms *"how would I even notice this?"* into a mechanical check reviewers can apply without domain immersion.
3. **Named failure mode.** The bug class can be described in a single sentence.
4. **Concrete past incident.** The PR itself (or the Issue it closes) is a real instance the invariant would have caught.

If any of the four fails, **do not propose**.

## Skip criteria (the PR itself does not warrant brewing)

Skip the PR (write nothing, record skip reason) when any of these hold:

- **Documentation-only**: the diff touches only `docs/**`, `.claude/**`, `README.md`, `CLAUDE.md`, or `*.md` files at the repo root.
- **Pure refactor**: the diff preserves behavior — no production logic change, only renames / extractions / formatting.
- **Test-only**: the diff touches only `*.test.*` / `__tests__/**` / `packages/integration/**`.
- **Single-callsite fix**: the bug was in one place, the fix is local, the pattern is not generalizable.
- **Already covered by an existing `I-N`**: the lesson from this PR is already the rule in the catalog. Optionally suggest strengthening the existing entry's "Example" section instead, but do not create a new proposal.

## Output: when proposing

Write `docs/context-store/_proposals/I-<next>-<slug>-pr<PR>.md` with this structure:

```markdown
---
proposed_id: I-<next>
slug: <short-name>
source_pr: <PR number>
source_issue: <Issue number if any>
brewed_at: YYYY-MM-DD
brewed_by: <Claude model or session id>
status: proposed
---

# I-<next>. <Short Name>

## Why this PR warrants a new invariant

<1-3 sentences linking the PR's concrete bug or change to a general pattern.
Cite the specific file / function / line where the pattern manifests.>

## Rule (draft)

<Abstract statement — same shape as existing I-1..I-7.>

## Why it matters

<1 paragraph describing the characteristic failure mode.>

## Detection heuristics (draft)

<3-5 bullet items. Each should be something a reviewer can mechanically apply.>

## Resolution patterns (draft)

<2-4 bullet items.>

## Example (from source PR)

<The concrete incident from this PR — what would have been caught and how.>

## Suggested acceptance criterion template

- [ ] <checklist template, same style as other catalog entries>

## Review questions for owner

- Is this truly cross-cutting, or specific to the current PR?
- Does it overlap with I-<M> (existing invariant)? If so, strengthen that entry instead.
- Is the proposed rule general enough to carry weight, but specific enough to be checkable?
- Is the suggested criterion template strong enough?
```

Keep each section concise. The proposal is a **draft** — the owner may rewrite; what matters is that the invariant class is clearly identified.

## Output: when skipping

Do not write a file. Print (or record elsewhere) a single line:

```
skip: PR #<N> — <reason category>: <short explanation>
```

Reason categories: `docs-only`, `test-only`, `pure-refactor`, `single-callsite`, `duplicates-I-<M>`, `other`.

## Anti-patterns the judge must avoid

- **Proposing the same invariant twice from different PRs.** Before writing, grep `_proposals/` and `_rejected/` for the candidate slug.
- **Re-stating an existing `I-N` as new.** Read the catalog before proposing. If the rule statement overlaps, do not propose.
- **Proposing from diff alone without Issue context.** The *why* matters. Read the linked Issue body.
- **Over-generalizing from one bug.** A single-callsite fix does not imply a cross-cutting invariant.
- **Proposing speculative invariants not grounded in this PR.** Every proposal must have a concrete incident from the source PR.

## Slug naming

- 2-5 lowercase words, hyphen-separated.
- Describe the invariant's content, not the PR's task. E.g., `state-persistence-restart` (good) vs `pr638-fix` (bad).
- Match the tone of existing catalog entries (I-1 "I/O Addressing Symmetry" → `io-addressing-symmetry` style).

## Integration

- Invoked via: `node .claude/skills/orchestrator/brew-invariants.js <PR>`
- Results reviewed by: owner (accept → edit catalog) or CTO (pre-review)
- Metrics tracked in: `docs/context-store/brewing-log.md` (§2 Live Pilot Log, updated per §7f invocation) or future dashboards

## Rubric reminders for the judge (quick reference)

- ALL four criteria must hold to propose.
- Check existing catalog (I-1..I-7) and `_rejected/` before writing.
- If unsure, **skip**. Over-proposing pollutes the review channel; under-proposing is recoverable (the pattern will resurface in a later PR).
- The proposal is a draft, not a final document.
