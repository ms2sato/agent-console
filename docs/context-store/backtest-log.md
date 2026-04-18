# Brewing Pilot — Backtest Log

**Date:** 2026-04-18
**Pilot commit:** feat/brewing-pilot
**Judge:** Orchestrator session `5637ab94-13f6-4f03-8df7-31c66f87fe3d` (agent-console)
**Catalog at test time:** `.claude/skills/architectural-invariants/SKILL.md` contains I-1..I-7

Backtest validates two things:

| Axis | Meaning | Case |
|---|---|---|
| **Recall** | Could brewing derive an invariant at the time the pattern first emerged? | Counterfactual #638 |
| **Precision** | Does brewing correctly skip PRs that do not warrant a new invariant? | #638 (current catalog), #654, #655, #656 |

---

## Case 1 — PR #638 (current catalog)

**PR:** [feat: session-data-path scope-based persistence](https://github.com/ms2sato/agent-console/pull/638) — closes #634

**Brewing decision:** `skip: PR #638 — duplicates-I-7: the pattern "data_scope_slug admits org/repo and repo shapes, each must be handled at every call site" is already the rule in I-7 Enumeration Exhaustiveness.`

**Assessment:** ✅ Correct. I-7 was added in PR #650 explicitly to cover this pattern (the catalog entry cites #638 as the seeding incident). Brewing identifying this as duplicate, rather than creating a new proposal, is the precision-preserving outcome.

---

## Case 1b — PR #638 (counterfactual: I-7 removed)

**Setup:** Hypothetical — what would brewing produce if run on #638 context with a catalog containing only I-1..I-6?

**Brewing decision:** `propose`

**Artifact:** [`_proposals/I-7-value-shape-exhaustiveness-pr638.md`](_proposals/I-7-value-shape-exhaustiveness-pr638.md)

**Assessment:** ✅ Recall validated.

The counterfactual proposal was written independently (not by copying the
final I-7 text). Comparing against the real I-7 in
`.claude/skills/architectural-invariants/SKILL.md`:

| Section | Counterfactual proposal | Real I-7 | Fidelity |
|---|---|---|---|
| Slug name | `value-shape-exhaustiveness` | "Enumeration Exhaustiveness" | close but not identical |
| Rule statement | multi-shape values → all shapes covered | same concept, tighter wording | high |
| Why-it-matters | default-shape-bias → silent else-branch → late user report | same mechanism | high |
| Detection heuristics | 5 items, 4 overlap with real (grammar admits optional, domain "or", fixtures use one shape, migration assumes one, enum switch without never) | 4 items, real has "optional-slash or optional-prefix regex" and "migration forgets a case" | close |
| Resolution | discriminated unions + never, table-driven tests, shape docs, review-time grep | same four patterns | close |
| Example | data_scope_slug grammar, 22-case test, owner-prompted repo-only question | same #638 context | same |
| Acceptance criterion | shapes enumerated in PR body + test per shape + every call site handles all shapes | same structure | close |

Brewing reproduces the invariant class with high fidelity. The slug differs
(verbose vs concise); the real I-7 is slightly more polished prose. Reviewer
would need to tighten wording but would not need to re-derive the concept.

---

## Case 2 — PR #655 (borderline)

**PR:** [fix: stop wiping terminal cache on server restart](https://github.com/ms2sato/agent-console/pull/655) — closes #648

**Brewing decision:** `skip: PR #655 — marginal-overlap-I-4: "cache should not be unnecessarily destroyed on restart" overlaps with I-4 State Persistence Survives Process Lifecycle, but is not cross-cutting enough to warrant a separate entry.`

**Reasoning:**

- I-4 requires that state persisted before `return success` survives crash / restart. The #648 bug is adjacent but inverse: state WAS persisted correctly, but restart logic explicitly wiped it (a separate bug class: "reset scope mis-targeting").
- Argument for new invariant: "Reset / reinitialize operations must scope what they clear — transient state only, never persisted state users rely on." Potential name: "Reset Scope Correctness".
- Argument against: the incident is one call site (the cache wipe on start). Generalization to "all reset logic" is speculative. Criterion (2) "High-leverage detection" is weak — no mechanical check surfaces this without domain knowledge of what users depend on.

**Conclusion:** Skip. Record as "potential future invariant if a second similar incident emerges from a different subsystem". Add note to I-4's `Example` section in a later catalog touch-up.

**Assessment:** ✅ Correct precision.

---

## Case 3 — PR #654 (docs-only)

**PR:** [docs: introduce narrative memory system for qualitative handoff](https://github.com/ms2sato/agent-console/pull/654)

**Brewing decision:** `skip: PR #654 — docs-only: diff touches only docs/ and .claude/ markdown.`

**Assessment:** ✅ Correct. Precision signal preserved.

---

## Case 4 — PR #656 (meta-framework)

**PR:** [docs: audit and resolve skill/rule duplication](https://github.com/ms2sato/agent-console/pull/656) — closes #651

**Brewing decision:** `skip: PR #656 — other: meta-framework hygiene (rule/skill organization), not a code behavior invariant. Adds a CI invariant (rule-skill-duplication-check.js) but at the wrong level for architectural-invariants catalog.`

**Reasoning:**

- The PR adds `rule-skill-duplication-check.js` as a CI invariant — but it checks that two markdown artifact classes (rules vs skills) don't drift or overlap. That is not a code or data invariant at the architectural level.
- The catalog's scope is runtime / data-shape invariants (I/O addressing, single writer, identity stability, persistence lifecycle, source of truth, boundary validation, enumeration exhaustiveness). Extending it to meta-framework artifact hygiene would dilute the catalog's purpose.
- If meta-framework hygiene deserves its own catalog, it should be a separate skill (e.g., `framework-invariants/`) not an entry here.

**Assessment:** ✅ Correct precision. Brewing recognizes domain boundary.

---

## Metrics summary

| Metric | Count | Note |
|---|---|---|
| PRs evaluated | 4 real + 1 counterfactual | |
| Proposals generated | 1 (counterfactual) | Recall validation |
| Skips (correct) | 4 | Precision validation |
| Skips (false negative) | 0 | No evidence of missed invariants |
| False positives | 0 | No speculative proposals |

**Skip reasons distribution:**
- `duplicates-I-<N>`: 1 (#638)
- `marginal-overlap`: 1 (#655)
- `docs-only`: 1 (#654)
- `other` (domain boundary): 1 (#656)

---

## Pilot learnings (2026-04-18)

1. **`brew-invariants.js` context packager works end-to-end.** Output is
   sufficient for the judging Claude to apply the rubric without additional
   fetches (apart from reading the catalog and brewing skill by path, which is
   intentional).
2. **Precision is the dominant outcome.** 4 of 4 real PRs correctly skipped.
   Over-proposal is not observed on this sample. This matches the expected
   signal density — new invariants are rare.
3. **Recall works on the one historical test case.** The counterfactual #638
   derivation reproduces I-7 with high fidelity.
4. **Catalog duplication check is the most important skip gate.** Without it,
   brewing would have proposed I-7 again for #638 in the current catalog state.
   The brewing skill's "read catalog before proposing" instruction is
   load-bearing.
5. **Borderline cases need recorded reasoning even when skipped.** #655 is
   arguably proposable. Recording the argument for/against in `backtest-log`
   captures the judgment for future brewing sessions to grep against.

## Open questions for Pilot evolution

- **Automation level.** Currently runs on human trigger. PR merge hook or
  daily cron would produce real Pilot data over weeks.
- **Metrics durability.** This log is hand-maintained. A `bun run brew:metrics`
  aggregator could count proposals / skips / acceptances from directory state.
- **conteditor horizontal deployment.** After 2 weeks of agent-console Pilot,
  port brewing to conteditor where `architectural-invariants` catalog does not
  yet exist. That deployment is both (a) initial-populate brewing from past
  PRs and (b) ongoing brewing — a richer Pilot.
