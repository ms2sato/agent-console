# Brewing Log

Ongoing record of brewing session decisions on merged PRs. Maintained by the Orchestrator as step 7f of the Post-Merge Flow (see `.claude/skills/orchestrator/core-responsibilities.md` §7f).

## Sections

- **§1. Initial Backtest (2026-04-18)** — pre-Pilot validation on 4 historical PRs + 1 counterfactual, establishing precision and recall signals before Live Pilot began.
- **§2. Live Pilot Log (2026-04-18 — 2026-05-02)** — append one row per merged PR during the Pilot window.
- **§3. Metrics & Learnings** — populated at Pilot end (2026-05-02).

---

## §1. Initial Backtest (2026-04-18)

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
   arguably proposable. Recording the argument for/against in the log
   captures the judgment for future brewing sessions to grep against.

## Open questions for Pilot evolution

- **Automation level.** Currently runs on human trigger per §7f. PR merge
  hook or `create_timer` based invocation could produce real Pilot data
  without Orchestrator intervention.
- **Metrics durability.** This log is hand-maintained. A `bun run brew:metrics`
  aggregator could count proposals / skips / acceptances from directory state.
- **conteditor horizontal deployment.** After the agent-console Pilot (ending
  2026-05-02), port brewing to conteditor where `architectural-invariants`
  catalog does not yet exist. That deployment is both (a) initial-populate
  brewing from past PRs and (b) ongoing brewing — a richer Pilot.

---

## §2. Live Pilot Log (2026-04-18 — 2026-05-02)

Append one row per merged agent-console PR brewed during the Pilot window. Reason categories: `docs-only`, `test-only`, `pure-refactor`, `single-callsite`, `duplicates-I-<M>`, `other`.

| Date | PR | Decision | Reason / Link |
|------|------|------|------|
| 2026-04-18 | [#672](https://github.com/ms2sato/agent-console/pull/672) | skip | `docs-only`: diff touches only `.claude/rules/design-principles.md` (+2 insertions). Added content is a process principle ("grep for sibling call sites before root-cause fixes"), not an architectural code invariant. All 4 catalog criteria fail — no mechanical detection heuristic, no named failure-mode at the code/data level. |
| 2026-04-18 | [#673](https://github.com/ms2sato/agent-console/pull/673) | skip | `docs-only`: diff touches only `docs/context-store/brewing-log.md` (+1 / −1). Log-maintenance entry for #672, no content of its own. No catalog criterion applies. |
| 2026-04-19 | [#674](https://github.com/ms2sato/agent-console/pull/674) | skip | `docs-only`: diff touches only `docs/narratives/*`, `docs/strategy/*`, `docs/context-store/*/README.md`, `.claude/rules/workflow.md`, `.claude/rules/pre-pr-completeness.md`. Strategic-position articulation and related policy artifacts. No code-behaviour change; no new cross-cutting architectural invariant class surfaced. All 4 catalog criteria fail. |
| 2026-04-18 | [#675](https://github.com/ms2sato/agent-console/pull/675) | skip | `docs-only`: diff touches only `docs/context-store/brewing-log.md` (+2 insertions). Log-maintenance batch covering #673 and #674; no content of its own. |
| 2026-04-20 | [#677](https://github.com/ms2sato/agent-console/pull/677) | skip | `docs-only`: adds `docs/design/shared-orchestrator-session.md` (+259 lines) describing the shared Orchestrator session design. Pure docs addition; no code behaviour change; no invariant class surfaced from the diff itself. |
| 2026-04-20 | [#679](https://github.com/ms2sato/agent-console/pull/679) | skip | `docs-only`: diff touches only `docs/context-store/brewing-log.md`. Log-maintenance entry covering #675 and #677 (their rows landed via this PR). No content of its own. No catalog criterion applies. |
| 2026-04-20 | [#681](https://github.com/ms2sato/agent-console/pull/681) | skip | `docs-only`: sprint retrospective improvements — touches `.claude/rules/{pre-pr-completeness,workflow}.md` and `.claude/skills/orchestrator/{SKILL,core-responsibilities}.md`. Process / rule / skill text changes (Pre-PR Gap-Scan additions, force-push gating, brewing-log batching convention, etc.). No code-behaviour change; no architectural code invariant class surfaced. All 4 catalog criteria fail. |
| 2026-04-25 | [#682](https://github.com/ms2sato/agent-console/pull/682) | skip | `docs-only`: shared-account session design reframe + journey narrative + narratives README "Language" convention. Touches `docs/design/shared-orchestrator-session.md`, `docs/narratives/2026-04-21-orchestrator-as-skill.md`, `docs/narratives/README.md`. Pure design and convention articulation; the doc enumerates implementation dependencies for a future iteration (Issue [#678](https://github.com/ms2sato/agent-console/issues/678)) but does not implement any of them. No code-behaviour change; no architectural code invariant class surfaced from the diff itself. |
| 2026-04-26 | [#687](https://github.com/ms2sato/agent-console/pull/687) | skip | `docs-only`: diff touches only `.claude/skills/orchestrator/check-utils.js` and its test (preflight-check local/CI mode parity, closes [#657](https://github.com/ms2sato/agent-console/issues/657)). Process tooling improvement; no production runtime behaviour change; no architectural code invariant class surfaced. |
| 2026-04-26 | [#691](https://github.com/ms2sato/agent-console/pull/691) | skip | `docs-only`: adds `docs/glossary.md` (22 entries + Maintenance section, closes [#685](https://github.com/ms2sato/agent-console/issues/685)). Pure documentation; no code-behaviour change. |
| 2026-04-26 | [#692](https://github.com/ms2sato/agent-console/pull/692) | skip | `duplicates-design-principles`: cross-package fix for the `\r?\n` → `\r` newline-vs-submit-signal contract drift (#660 root cause). The structural prevention is realised in PR [#694](https://github.com/ms2sato/agent-console/pull/694) via type-level separation, which is the expected application of `.claude/rules/design-principles.md` "Enforce constraints through structure, not convention" — not a new invariant class for the catalog. |
| 2026-04-26 | [#688](https://github.com/ms2sato/agent-console/pull/688) | skip | `other`: SQLite migration mechanics (ALTER TABLE RENAME × dependent FK auto-rewrite, table-recreation pattern reversal, DB backup logic, FK validation moved inside the migration transaction). The migration framework restructure is filed as Issue [#693](https://github.com/ms2sato/agent-console/issues/693); deferring invariant evaluation until post-refactor so the right surface for any new invariant (e.g. "migration FK validation must run inside the same transaction as the version bump") is clear. |
| 2026-04-26 | [#694](https://github.com/ms2sato/agent-console/pull/694) | skip | `duplicates-design-principles`: Type Safety + Separation of Concerns (branded `MessageContent` / `SubmitKeystroke` types + `MessageContentProcessor` / `PTYOperationExecutor` responsibility split, 200+ contract tests). This is the intended *application* of `.claude/rules/design-principles.md` "Enforce constraints through structure, not convention" — not a new invariant class for the catalog. |
| 2026-04-26 | [#695](https://github.com/ms2sato/agent-console/pull/695) | skip | `docs-only`: sprint retrospective improvements — process rule additions to `.claude/rules/workflow.md` and `.claude/skills/orchestrator/core-responsibilities.md`, plus a 1-line typecheck script tweak in `packages/client/package.json` (presence-check guard for `routeTree.gen.ts`). Process / rule changes; the script tweak is a single-callsite fix. No architectural code invariant class surfaced. |
| 2026-04-28 | [#709](https://github.com/ms2sato/agent-console/pull/709) | skip | `process-captured`: `fs.watch` inode-binding gotcha (atomic rename via `git`'s `HEAD.lock → HEAD` detaches the watcher). Real bug, real fix (watch directory + filename filter). However the lesson was captured at the right level by Sprint 2026-04-28 retrospective — `pre-pr-completeness.md` Q3.5 explicitly calls out the "filesystem watcher sibling check" as a mechanical pre-PR check. Adding a separate I-N would duplicate the mechanical gate. |
| 2026-04-28 | [#711](https://github.com/ms2sato/agent-console/pull/711) | skip | `single-feature`: introduces `outputMode: "pty" \| "message"` parameter to `run_process` MCP tool, routing long-paragraph script I/O via inter-session messages instead of PTY. Net feature addition; UTF-16 surrogate pair correctness was caught by GitHub-side CodeRabbit review and addressed in the same PR. Does not surface a new invariant class — the surrogate-pair lesson is already a known general string-handling concern. |
| 2026-04-28 | [#714](https://github.com/ms2sato/agent-console/pull/714) | skip | `docs-only`: codifies Browser QA skip threshold in `.claude/rules/workflow.md` and `frontend-standards.md`. `[skip ci]` PR. Pure rule-text documentation. |
| 2026-04-28 | [#716](https://github.com/ms2sato/agent-console/pull/716) | skip | `process-tooling`: adds language-agnostic ASCII / non-Latin-Letter check via `scripts/check-public-artifacts-language.mjs` + integration with `preflight-check.js` + new `language-lint.yml` workflow. The check is the *implementation* of the existing Language Policy rule in `workflow.md`; the rule itself is the invariant. No new code-level invariant class surfaced. The `setup-bun` cross-runtime spawn lesson was captured in `workflow.md` "CI Failure: Self-Diagnosis Before Assumption" reverse case (Sprint 2026-04-28 retro). |
| 2026-04-28 | [#721](https://github.com/ms2sato/agent-console/pull/721) | skip | `docs-only`: Sprint 2026-04-28 retrospective improvements (acceptance-check.js Q10 / Concerns Surfacing Discipline mechanization + Boundary Values rule). Pure rule / skill / process documentation. |
| 2026-04-30 | [#724](https://github.com/ms2sato/agent-console/pull/724) | skip | `docs-only`: adds Inter-Session Messaging entry to `docs/glossary.md` (canonical entry under Events & Communication for `send_session_message` + `outputMode: "message"` channel). Pure documentation; alongside CodeRabbit-driven path-format consistency fix that bundled an existing `outputMode` entry's `../`-prefix per `design-principles.md` "sibling call sites" rule. |
| 2026-04-30 | [#725](https://github.com/ms2sato/agent-console/pull/725) | **propose** | **I-8 candidate**: Shared-Resource Artifact Lifetime — see [`_proposals/I-8-shared-resource-artifact-lifetime-pr725.md`](_proposals/I-8-shared-resource-artifact-lifetime-pr725.md). Installer wrote a symlink into the worktree-shared `<git-common-dir>/hooks/`; the embedded symlink target was cwd-anchored to the linked worktree, so removing that worktree silently broke the language gate. Hot-fix PR #729 (Issue #728) confirmed the failure mode. All four catalog criteria hold. |
| 2026-04-30 | [#726](https://github.com/ms2sato/agent-console/pull/726) | skip | `process-captured`: workflow file rename (`coverage-check.yml` → `preflight.yml`) + active rule references updated, with intentional preservation of historical narrative entries. Cross-PR coordination concern (branch protection `required_status_checks` + open PRs needing rebase) was surfaced by orchestrator. Lesson is captured at the right level by `#726` retrospective proposal A — a new "Workflow rename / deletion checklist" item for `pre-pr-completeness.md` (next sprint follow-up). Not an architectural code invariant. |
| 2026-04-30 | [#727](https://github.com/ms2sato/agent-console/pull/727) | skip | `security-pattern-not-code-invariant`: PreToolUse denylist hook (jq-based, fail-closed, 186 lines + 61 tests + README). Defense-in-depth pattern protecting against agent ask-fatigue / `--dangerously-skip-permissions` bypass. Cross-cutting and high-leverage but the "use a mechanical gate to enforce policy that humans/agents may bypass under cognitive load" pattern is a security philosophy, not a code-correctness invariant in the I-1..I-7 catalog's shape (addressing / persistence / validation). The existing entries are about runtime correctness; this is about enforcement of out-of-band policy. Could become its own catalog category in a future sprint if more sibling instances appear. |
| 2026-04-30 | [#729](https://github.com/ms2sato/agent-console/pull/729) | skip | `duplicates-I-8`: hot-fix for the `install-hooks.mjs` cwd-binding bug introduced in #725 (Issue #728). Same lesson as #725; the proposed I-8 from #725 already covers the invariant class. Recording the duplication here for trail-through-time. |

For `propose` rows, link to the proposal file in `_proposals/` in the "Reason / Link" column. For `skip` rows, write the reason category and a short explanation.

### Running brewing (reminder)

```bash
# After each PR merge, as part of Post-Merge Flow step 7f:
node .claude/skills/orchestrator/brew-invariants.js <merged-PR>
# Then apply .claude/skills/brewing/SKILL.md rubric and append row below.
```

---

## §3. Metrics & Learnings (populated at Pilot end, 2026-05-02)

### Counts
- Total PRs brewed: _TBD_
- Proposals generated: _TBD_
- Proposals accepted into catalog: _TBD_
- Proposals rejected (moved to `_rejected/`): _TBD_
- Skip distribution: _TBD_

### Qualitative learnings
_TBD at Pilot end._

### Decision
_TBD: continue / tighten / loosen / retire._
