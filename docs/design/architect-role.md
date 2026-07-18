# Architect Role

Owner-facing single-role interface stays with the Orchestrator; internally the Orchestrator delegates design / spec / audit responsibilities to a general **Architect** — one Architect session per repository.

## 1. Motivation

The Orchestrator role has accumulated three families of responsibility that pull in opposite directions:

1. **Coordination** — dispatch, first-responder, work review, prioritization, merge authority (fast, breadth-first)
2. **Design and audit** — spec drafting, design review, multi-round audit, cross-domain design consultation (slow, depth-first)
3. **Housekeeping** — retro, rule maintenance, cross-project share

Per-sprint retros repeatedly surface rule/skill additions to close *design* gaps (symmetry checks, "who reads this?" reviews, execution-result-as-contract discipline). Piling those onto the Orchestrator role dilutes coordination throughput and increases the cognitive load of a role that is supposed to be an at-a-glance owner interface. The embedded-agent domain has already operated with a de-facto separate architect (session `84a3a530`) since Sprint 2026-07-11, and three generations of that session have shown the split works. Generalize the pattern.

## 2. Architect responsibilities

The Architect **owns the quality of implementation artifacts**. From an Issue's AC through delivered code, the Architect is the accountable role for "does this correctly and appropriately solve the problem." Concretely:

- **Acceptance Criteria drafting** — writing the AC for every Issue that will be delegated. Because delegate workers run on a lower-tier model (see §10), the AC is **prescriptive**: it names the specific files to touch, the interface shape to preserve or change, the invariants to hold, the tests to add, and the failure modes to avoid. "Behavior-only" AC is insufficient; include implementation guidance whenever the correct approach is non-obvious to a mid-tier worker.
- **Implementation code appropriateness review** — post-delegation, review whether the delivered code actually satisfies the AC and whether the code is appropriate as code (structure, naming, invariants, sibling-site consistency, error handling shape). The Orchestrator handles behavior verification (tests / CI / dogfood); the Architect handles code appropriateness.
- **Design review** — PR-level spec/architecture check when the change is spec-shaped or crosses design boundaries
- **Spec drafting** — writing / refining design docs (`docs/design/**`), trade-off analysis
- **Multi-round audit** — per-round verdict (`CLEAN` / `CLEAN-WITH-FOLLOWUPS` / `CHANGES-REQUESTED`) on complex PRs, especially those with 3+ CR findings or spec-derivation risk
- **Cross-domain design consultation** — when a change would touch multiple design docs / packages / architectural-invariants
- **Direct implementation-support channel** — workers may consult the Architect directly during implementation when uncertain (see §6). The Architect is expected to answer without routing back through the Orchestrator.
- **Design-discipline rule authorship** — rules whose home is design-review (e.g., symmetry check, execution-result-as-contract) are drafted by the Architect and reviewed by the Orchestrator before landing

The Architect does NOT own:

- Delegation / dispatch (Orchestrator)
- Merge authority (Orchestrator, subject to owner)
- Retro execution, rule maintenance sweeps, cross-project knowledge share (Orchestrator)
- Behavior verification / test execution / CI monitoring / dogfood (Orchestrator)
- First-responder for non-technical / procedural questions (Orchestrator)

## 3. Boundary with Orchestrator (gray zone resolution)

Owner directive (2026-07-18): **all housekeeping / retro / rule-maintenance / cross-project-share responsibilities stay with the Orchestrator.** The Architect focuses narrowly on design / spec / audit.

Practical split:

| Concern | Owner |
|---|---|
| Prioritization | Orchestrator |
| Issue creation (title / body / scope) | Orchestrator |
| **Acceptance Criteria authoring** | **Architect** (prescriptive, implementation-guidance included) |
| Delegation prompt assembly | Orchestrator (uses AC drafted by Architect) |
| First-responder for procedural / non-technical delegate questions | Orchestrator |
| **First-responder for implementation-uncertainty delegate questions** | **Architect** (worker may push direct) |
| Behavior verification / test / CI / dogfood | Orchestrator |
| **Implementation code appropriateness review** | **Architect** |
| Acceptance check (final gate before merge) | Orchestrator (combines behavior + Architect verdict) |
| Merge | Orchestrator (subject to owner authority thresholds) |
| Multi-round audit on complex PRs | **Architect** |
| Spec drafting / design doc | **Architect** |
| Cross-domain design consultation | **Architect** |
| Retro Steps 1-8 | Orchestrator |
| Rule / skill maintenance | Orchestrator (Architect drafts design-discipline rules) |
| Cross-project retro share | Orchestrator |

## 4. When to consult the Architect

### 4a. Orchestrator → Architect (routine consultation)

The Orchestrator pushes to the Architect for:

- **Every Issue AC drafting** — before delegation, ask the Architect to write the prescriptive AC (this is the default flow, not an exception)
- **Every delivered PR** — request code appropriateness review after the delegate reports implementation-complete but before Orchestrator's acceptance check finalizes
- **Spec / design doc changes** — any PR that adds or substantially modifies `docs/design/**`
- **Cross-package refactors** — changes that touch `packages/shared/*` types plus one or more consumer packages simultaneously
- **New agent kind / worker kind / execution surface** — anything that triggers `pre-pr-completeness.md` Q11
- **Architectural-invariants impact** — any change flagged by `suggest-criteria.js` as touching an I-N invariant
- **Complex PR audit** — multi-round PRs (3+ commits driven by review feedback, or 5+ CR findings)
- **Design-discipline rule proposals** — retro items in the "design discipline" family

The Orchestrator does NOT push to the Architect for:

- Doc typo fixes / language-check-only edits
- Retro / rule maintenance items that are pure operational tips (Orchestrator drafts alone; if the item is design-shaped, the Architect drafts it per §2)
- Trivial mechanical batches where the AC is a 1-line "remove all occurrences of X" and code review is `git diff | wc -l`-sized

### 4b. Worker → Architect (direct implementation-support channel)

Delegate workers **may consult the Architect directly** — bypassing the Orchestrator — when they encounter implementation uncertainty during a task. Typical cases:

- Ambiguity in the AC that only the AC author can resolve
- A code-shape decision (which of two structurally equivalent approaches to take)
- Discovery that the AC's prescribed implementation collides with a constraint the AC author did not know about
- A sibling-site consistency question ("this function has a nearby analogue — should I follow it or diverge?")

The worker uses `send_session_message` (or equivalent) to push the question to the Architect session. The Architect responds without routing back through the Orchestrator. The Orchestrator is informed via the worker's next work report (and via the memo, if the exchange changed the AC or design meaningfully).

This channel exists because the AC drafting is prescriptive but not exhaustive; implementation surface always exceeds spec. Rather than force the worker to guess and ship a wrong implementation, the direct channel lets the accountable role (Architect) close the loop in one hop.

The Orchestrator does NOT need to gate or approve these worker-initiated consultations — they are default-allowed. If they become excessive (Architect saturation), the Orchestrator addresses that as a workload issue in a subsequent retro, not by blocking the channel.

## 5. Instantiation: one Architect session per repository (Model A)

Owner directive (2026-07-18): **one Architect per repository**, persistent session (not on-demand agent, not skill-only, not per-domain).

Rationale:
- Persistent memory continuity (multi-sprint spec threads, cross-PR context)
- One "home" for design conversations reduces context re-load overhead
- The embedded-agent-designer track has already validated the shape at repository scope

Instantiation mechanism:
- Orchestrator on startup checks whether an Architect session/worktree exists for the current repository
- If absent, Orchestrator creates a new Architect worktree (via `delegate_to_worktree` with the Architect skill / agent template)
- Owner interacts only with the Orchestrator; the Architect is an internal collaborator

## 6. Hand-off protocol

The Architect is **idle-until-explicit-push** and **does not observe ambient state**. The Architect session does not act unless someone (Orchestrator or delegate worker) sends an explicit message (via `send_session_message` or equivalent). It also does not watch CI status, PR review state, dogfood observations, sprint progress, or any repository-level signal that has not been pushed to it. All context is delivered by the pusher.

Consequence for the pushing side:
- After dispatching work to the Architect, verify the push landed (a message file was written) before moving on
- Do not assume "the Architect will notice" — the Architect notices what is pushed, nothing else
- **Package the necessary context into the push**: the Architect cannot check CI, cannot query PR status, cannot observe merge conflicts, cannot see whether dogfood ran. Include those signals in the message body when they affect the requested judgment. Typical context to include when requesting a code appropriateness review: PR number, AC reference, CI verdict (green / red with details), behavior verification result (tests / dogfood outcome), any Orchestrator concerns, links to prior audit rounds if this is a re-audit.
- Long-running architect audits still need push-side timer / progress tracking

### AC drafting flow (Orchestrator → Architect → Orchestrator)

1. Orchestrator identifies an Issue to delegate, prepares scope / context
2. Orchestrator pushes to Architect: "Draft AC for Issue #NNN, context: ..."
3. Architect returns the AC (prescriptive: files, interfaces, invariants, tests, failure modes, implementation guidance)
4. Orchestrator posts the AC to the Issue body and delegates

### Implementation-support flow (Worker → Architect → Worker)

1. Delegate worker hits implementation uncertainty
2. Worker pushes directly to Architect: "Working on #NNN, uncertain about X. Options A / B / details ..."
3. Architect responds directly to worker with the decision
4. Worker proceeds; the exchange is summarized in the worker's next report to Orchestrator

### Code appropriateness review flow (Orchestrator → Architect → Orchestrator)

1. Delegate worker reports implementation-complete (all tests green, PR pushed)
2. Orchestrator runs behavior verification (CI status, dogfood if applicable)
3. Orchestrator pushes to Architect: "Review PR #NNN for code appropriateness against AC #NNN"
4. Architect returns verdict (see §2): `CLEAN` / `CLEAN-WITH-FOLLOWUPS` / `CHANGES-REQUESTED`
5. If `CHANGES-REQUESTED`: Orchestrator relays to delegate, delegate fixes, Orchestrator re-pushes to Architect for next round
6. Merge only after Architect verdict is `CLEAN` or `CLEAN-WITH-FOLLOWUPS` AND Orchestrator's own acceptance check (behavior side) passes

## 7. Migration from the embedded-agent architect

Sprint 2026-07-11 → 2026-07-18: embedded-agent domain operated with session `84a3a530` as a de-facto domain-specific Architect. Three generations of that session have completed handoffs successfully.

**Next sprint transition:**
- Session `84a3a530` is repurposed as the **general Architect** (not embedded-agent-specific)
- The existing handoff memory (`project_embedded_agent_architect_handoff.md`) remains as the domain-specific baseline; a general handoff memory (`project_architect_handoff.md`) is drafted on next Architect generation change
- Consult trigger expands from "embedded-agent domain" to the broader triggers in §4
- Prior domain-specific decisions (tool surface / MessagePanel / instruction loader / preview security / initialPrompt delivery) remain binding — the domain expertise carries over

## 8. Skill + auto-provisioning handshake

Owner directive (2026-07-18): a dedicated Architect skill exists (`.claude/skills/architect/SKILL.md`), and the Orchestrator skill auto-provisions the Architect session on startup if absent. Owner interacts only with the Orchestrator skill.

**Handshake at Orchestrator startup:**

1. Read the Orchestrator skill's First Action.
2. Before the sprint-lifecycle procedure runs, check for an existing Architect session in the current repository via `list_sessions`.
3. If none exists (or the existing designated session is inactive):
   - Create an Architect worktree (branch name convention: `architect/main` or per-repo equivalent)
   - Spawn an Architect worker in that worktree using the model default from §10 (fable)
   - Instruct the Architect worker to load `.claude/skills/architect/SKILL.md` as its role
4. Record the Architect session ID in `memory/project_architect_handoff.md` (or the existing `project_embedded_agent_architect_handoff.md` for the transition sprint) so subsequent Orchestrator sessions find it.
5. Proceed to normal Orchestrator startup.

The owner never invokes `/architect` directly. The Orchestrator is the single owner-facing role; the Architect is an internal collaborator the Orchestrator can consult.

## 9. Success criteria

The role split is working if, over the next 3 sprints:

- Retro Step 4 additions to Orchestrator-side rules shrink (design-discipline rules land in Architect skill instead)
- Orchestrator memos surface "pending: architect audit" as a distinct queue rather than mixing with dispatch queue
- Owner intervention on spec-shaped decisions reduces (Architect drafts, Orchestrator relays)
- Multi-round audit PRs (large embedded-agent-style deliveries) do not regress in verdict quality

Failure modes to watch:

- Architect silence (idle without notice) → Orchestrator did not push, or push was lost. Detect via startup handshake + Orchestrator self-check
- Double work (Orchestrator and Architect both drafting the same rule) → responsibility split not internalized. Detect via retro
- Consult trigger drift (Orchestrator handling spec-shaped work alone) → §4 triggers not fired. Detect via post-merge audit of Orchestrator-solo PRs against the trigger list

## 10. Model defaults

Owner directive (2026-07-18):

- **Delegate workers**: `sonnet` (default), consistent with the existing convention in `memory/feedback_delegate_model_sonnet5.md`
- **Architect**: `fable`

Rationale:
- Workers execute concrete implementation, where `sonnet` provides strong code-generation throughput at cost-efficient token pricing
- Architect performs design review / spec drafting / long-horizon audit, where `fable`'s deeper reasoning suits the fewer-but-heavier judgments the role requires

Overrides:
- Individual delegate templates may pin a higher-tier model when the specific task warrants (e.g., `--model {{model:claude-opus-4-7}}` for exceptionally complex refactors), per existing `templateVars` mechanism
- Owner may pin a different Architect model for a specific consultation if the default does not fit

## References

- [`../glossary.md`](../glossary.md) — canonical terminology (Architect / Orchestrator entries to be added in the same PR)
- [`.claude/skills/orchestrator/SKILL.md`](../../.claude/skills/orchestrator/SKILL.md) — owner-facing role
- [`.claude/skills/architect/SKILL.md`](../../.claude/skills/architect/SKILL.md) — Architect skill (new in this PR)
- `memory/project_embedded_agent_architect_handoff.md` — current handoff spec (transitions to general in next sprint)
- `memory/feedback_ac_and_architecture_via_designer.md` — the pre-existing consult pattern this rule generalizes
