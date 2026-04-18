---
proposed_id: I-7
slug: value-shape-exhaustiveness
source_pr: 638
source_issue: 634
brewed_at: 2026-04-18
brewed_by: orchestrator-session-5637ab94 (agent-console)
status: proposed-backtest-counterfactual
backtest_note: |
  This proposal is a brewing counterfactual. The real catalog added I-7
  "Enumeration Exhaustiveness" in PR #650 after Sprint 2026-04-17
  retrospective. This file is brewing's derivation of the SAME invariant
  class directly from PR #638 context, to validate brewing RECALL:
  "could the brewing rubric have surfaced I-7 at PR #638 merge time,
  before PR #650 formalized it?"

  The content here is independently generated from #638 diff + Issue #634
  body + the pre-I-7 catalog (I-1..I-6). It is NOT a copy of the final
  I-7 text. Compare with `.claude/skills/architectural-invariants/SKILL.md`
  section I-7 to assess recall fidelity.
---

# I-7. Value Shape Exhaustiveness

## Why this PR warrants a new invariant

PR #638 introduces `data_scope_slug` with grammar
`^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$`. The optional `(\/[A-Za-z0-9._-]+)?`
admits **two valid shapes**: `org/repo` (two-segment) and `repo` (one-segment
local project). The PR handles both — the 22-case adversarial slug test and
the V18 migration backfill each cover healthy multi-segment AND single-segment
inputs — but the PR's own "Test plan" checklist does not mechanically force the
dual-shape question. The review surfaced it through a direct owner prompt
("does this handle repo-only names too?") rather than through catalog-driven
acceptance criteria.

No existing catalog entry (I-1..I-6) surfaces this class of concern. I-1
(Addressing Symmetry), I-2 (Single Writer), I-3 (Identity Stability), I-4
(Persistence Lifecycle), I-5 (Server Source of Truth), I-6 (Boundary
Validation) all touch adjacent territory, but none of them forces a reviewer
to enumerate the valid shapes of a single value and verify each is handled at
every consuming call site.

## Rule (draft)

For a value admitting multiple valid shapes or formats, every code path —
validation, persistence, serialization, deserialization, rendering, migration,
cross-process transport — must cover ALL shapes, and every shape must be
exercised by at least one test.

## Why it matters

The characteristic failure mode: when one shape is the "default" that
developers mentally model, the other shape silently takes an unhandled
fall-through branch. The code type-checks and runs; the only external signal
is a user reporting "this feature doesn't work for my case." That signal
typically arrives long after the code has shipped, bypassed review, and
accreted dependent code paths that also assume the default shape.

This is distinct from I-6 (Boundary Validation): I-6 asks whether untrusted
input is validated at all. This invariant asks whether the internal
enumeration of shapes after validation is complete and mechanically checked.

## Detection heuristics (draft)

1. **Grammar admits optional segment.** A regex like `^foo(\/bar)?$`, union
   types `A | B`, or discriminated enums all flag the value for exhaustiveness
   review.
2. **Domain description uses "or" / "either" / "depending on".** Grep design
   docs and Issue bodies for these connectives — each one names a shape
   boundary.
3. **Test fixtures use only one shape.** If every test row picks the same
   shape variant, the other shapes are uncovered. Table-driven tests with one
   row per shape make the gap visible.
4. **Migration or backfill path assumes one shape.** A migration that only
   handles the common case silently corrupts or orphans the uncommon one on
   upgrade.
5. **Enum `switch` without `default: assert never`.** Without the `never`
   assertion, an unknown case flows through the default branch with no
   compile-time error.

## Resolution patterns (draft)

- **Discriminated unions with exhaustive `switch`.** Pair with a `default:`
  branch that asserts `never` so the compiler forces a new case when a shape
  is added.
- **Table-driven tests, one row per shape.** Reviewers immediately see missing
  rows.
- **Document valid shapes adjacent to the type.** If the type admits multiple
  shapes, the comment or Zod schema description enumerates each.
- **Grep-based invariant in review.** For known multi-shape fields, reviewers
  walk each shape against each call site.

## Example (from source PR)

`data_scope_slug` in PR #638 permits `org/repo` (e.g., `ms2sato/agent-console`)
and `repo` (e.g., `my-local-project`). The PR correctly covers both in
`computeSessionDataBaseDir`, V18 migration backfill, orphan detection, and
`SessionDataPathResolver`. But the completeness is achieved by diligent
implementation, not by catalog-driven acceptance. A reviewer asked explicitly
about the `repo` shape, which could have been missed.

Review question that would have surfaced it mechanically: *"What is the full
enumeration of valid shapes for `data_scope_slug`? For each shape, is there a
test? For each call site that consumes the value, does it handle all shapes?"*

## Suggested acceptance criterion template

- [ ] All value shapes introduced or touched by this change are enumerated
  explicitly in the PR description. Each shape has at least one test
  exercising it. All consumer call sites handle each shape — no silent
  fallback to the "default" one → unit / integration test per shape.

## Review questions for owner

- Is this truly cross-cutting, or bounded to validation-shaped values
  specifically?
- Does it overlap with I-6 (Boundary Validation)? Suggested framing: I-6 is
  about "validate at the boundary at all"; this one is about "after
  validation, handle every shape downstream".
- Should the rule explicitly name discriminated-union / `never`-assertion as
  a sub-case, or stay general?
- Is the suggested criterion template strong enough for
  `acceptance-check.js` (Q8-equivalent) to use mechanically?
