# Architect Role

Owner-facing single-role interface stays with the Orchestrator; internally the Orchestrator delegates design / spec / audit responsibilities to a general **Architect** — one Architect session per repository.

## 1. Motivation

The Orchestrator role has accumulated three families of responsibility that pull in opposite directions:

1. **Coordination** — dispatch, first-responder, work review, prioritization, merge authority (fast, breadth-first)
2. **Design and audit** — spec drafting, design review, multi-round audit, cross-domain design consultation (slow, depth-first)
3. **Housekeeping** — retro, rule maintenance, cross-project share

Per-sprint retros repeatedly surface rule/skill additions to close *design* gaps (symmetry checks, "who reads this?" reviews, execution-result-as-contract discipline). Piling those onto the Orchestrator role dilutes coordination throughput and increases the cognitive load of a role that is supposed to be an at-a-glance owner interface. The embedded-agent domain has already operated with a de-facto separate architect (session `84a3a530`) since Sprint 2026-07-11, and three generations of that session have shown the split works. Generalize the pattern.

## 2. Architect responsibilities

The Architect owns:

- **Design review** — PR-level spec/architecture check when the change is spec-shaped or crosses design boundaries
- **Spec drafting** — writing / refining design docs, AC definition, trade-off analysis
- **Multi-round audit** — per-round verdict (clean / clean-with-followups / changes-requested) on complex PRs, especially those with 3+ CR findings or spec-derivation risk
- **Cross-domain design consultation** — when a change would touch multiple design docs / packages / architectural-invariants
- **Design-discipline rule authorship** — rules whose home is design-review (e.g., symmetry check, execution-result-as-contract) are drafted by the Architect and reviewed by the Orchestrator before landing

The Architect does NOT own:

- Delegation / dispatch (Orchestrator)
- Merge authority (Orchestrator, subject to owner)
- Retro execution, rule maintenance sweeps, cross-project knowledge share (Orchestrator)
- First-responder for delegate questions (Orchestrator)

## 3. Boundary with Orchestrator (gray zone resolution)

Owner directive (2026-07-18): **all housekeeping / retro / rule-maintenance / cross-project-share responsibilities stay with the Orchestrator.** The Architect focuses narrowly on design / spec / audit.

Practical split:

| Concern | Owner |
|---|---|
| Prioritization | Orchestrator |
| Issue creation with AC | Orchestrator drafts, Architect reviews spec-shaped ACs |
| Delegation prompt authoring | Orchestrator |
| First-responder for delegate questions | Orchestrator |
| Work-report review | Orchestrator |
| Acceptance check | Orchestrator (invokes Architect for design-shaped concerns only) |
| Merge | Orchestrator (subject to owner authority thresholds) |
| Multi-round audit on complex PRs | **Architect** |
| Spec drafting / design doc | **Architect** |
| Cross-domain design consultation | **Architect** |
| Retro Steps 1-8 | Orchestrator |
| Rule / skill maintenance | Orchestrator (Architect drafts design-discipline rules) |
| Cross-project retro share | Orchestrator |

## 4. When to consult the Architect

The Orchestrator invokes the Architect for:

- **Spec / design doc changes** — any PR that adds or substantially modifies `docs/design/**`
- **Cross-package refactors** — changes that touch `packages/shared/*` types plus one or more consumer packages simultaneously
- **New agent kind / worker kind / execution surface** — anything that triggers `pre-pr-completeness.md` Q11
- **Architectural-invariants impact** — any change flagged by `suggest-criteria.js` as touching an I-N invariant
- **Complex PR audit** — multi-round PRs (3+ commits driven by review feedback, or 5+ CR findings)
- **Design-discipline rule proposals** — retro items in the "design discipline" family

The Orchestrator does NOT invoke the Architect for:

- Straight bug fixes with narrow scope (Orchestrator handles alone)
- Test-only additions
- Doc typo fixes
- Retro / rule maintenance items that are operational tips (Orchestrator drafts alone)

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

The Architect is **idle-until-explicit-push**. The Architect session does not act unless the Orchestrator sends an explicit message (via `send_session_message` or equivalent). This is not a bug — it is the design.

Consequence for the Orchestrator:
- After dispatching design work to the Architect, verify the push landed (a message file was written) before moving on
- Do not assume "the Architect will notice" — the Architect notices what is pushed, nothing else
- Long-running architect audits still need Orchestrator-side timer / progress tracking

Multi-round audit flow:
1. Orchestrator pushes PR + audit request to Architect
2. Architect returns verdict (clean / clean-with-followups / changes-requested)
3. If changes-requested: Orchestrator relays to delegate, delegate fixes, Orchestrator re-pushes to Architect for next round
4. Merge only after Architect verdict is `clean` or `clean-with-followups` AND Orchestrator's own acceptance check passes

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
