# agent-console Strategy Overview

This document captures the operating posture for agent-console: what it is, what it refuses to become, and what shapes a "yes / no / defer" judgment when a new Issue, PR, or skill is proposed.

For the phenomenological account of how this position was formed, see `docs/narratives/2026-04-18-strategic-position.md`. This document is prescriptive — read it when making prioritization or design decisions.

## Mission

**Build the best possible PTY-based platform for operating LLMs.**
Every design choice follows from this architectural commitment.

- Not a UI wrapper for any specific LLM — LLM-agnostic by construction.
- Not a lock-in vector. Eventually, useful components should be extractable as standalone libraries / cross-platform binaries.

## Positioning

agent-console is two things at once:

1. **A reference application** that demonstrates how an LLM-orchestrated development team can operate today.
2. **A collection of components** that other applications can reuse — forming, over time, a de-facto open standard for LLM orchestration that exists **alongside, not against,** the managed frameworks provided by LLM vendors (Anthropic Agent SDK, Claude Agent Team, etc.).

We coexist with vendor frameworks. We do not compete by copying their scope.

## Core Design Principles

### 1. LLM is the brain; the platform is external stimulus

- **LLMs decide.** Their strength is judgment.
- **The platform prepares.** Scripts, skills, MCP tools, event triggers, and persistence provide the structured context LLMs need and actuate decisions LLMs produce.
- **Do not push LLM-side decisions into the platform.** Do not push platform-side plumbing into the LLM.

### 2. Do not fear overlap with Claude (or any specific LLM)

- If Claude Code, Claude Agent SDK, or Anthropic Managed Agents provides a feature, that is not a reason for agent-console to skip it.
- Agent-console's value is **provider-independent implementation**: the same capability available regardless of which LLM is in use.
- When a vendor-provided feature is richer than agent-console's equivalent, note the gap as acceptable. Coverage ≠ competition.

### 3. Agent-side: hooks fade, skills stay

- **Hooks** (LLM-internal event listeners) are appropriate on the LLM side today, but the abstraction is too low to survive long. Higher-level event triggers will migrate to platform-level (AgentConsole, orchestrator skills).
- **Skills** are now a general LLM-side concept and stay on the LLM side.
- **Whatever a skill invokes** (scripts, async jobs, file I/O, external APIs) belongs on the platform — because re-implementing it per LLM is waste.

### 4. Code where code can; LLM where only LLM can

- The characteristic trap of current LLM-augmented development: laziness. Humans know code would be cheaper and more deterministic, but default to asking the LLM because "the LLM can probably do it."
- agent-console refuses this default. Where a script can prepare the information an LLM needs — file lists, diff summaries, pattern matches, rubric references, invariant checks — **write the script**. Leave LLM calls for genuine judgment: interpretation, synthesis, novel reasoning.
- Concrete exemplars already in the codebase:
  - `.claude/skills/orchestrator/brew-invariants.js` — context packager, zero LLM calls
  - `.claude/skills/orchestrator/preflight-check.js` + `.claude/rules/test-trigger.md` — file pattern → test requirement, mechanical
  - `.claude/skills/orchestrator/delegation-prompt.js` — prompt scaffolding is code; only the "Key Implementation Notes" section is LLM-filled
  - `.claude/skills/orchestrator/rule-skill-duplication-check.js` — grep-based invariant, no LLM

### 5. Extractability posture

New components should be designed as if they might one day be extracted into a standalone package or cross-platform binary:

- **Prefer pure functions + CLI surfaces** over stateful classes with deep TS-only dependencies.
- **Minimize transitive dependencies** — rely on Node/Bun built-ins where possible.
- **Keep API surfaces small and stable** — callers should invoke via documented boundaries, not internal structure.

We do not have to extract anything today. The point is that **nothing we build should be painful to extract later**. The migration path:

1. **Stage 1 (today):** Skill-local or application-local. Accept some drift across projects as the price of low overhead.
2. **Stage 2:** Monorepo-internal extraction — becomes a `packages/<name>` workspace, still consumed by agent-console but independently testable.
3. **Stage 3:** External distribution — npm package, cross-platform binary, or skill catalog entry.

Triggers for Stage 1 → Stage 2: three or more projects using the same script, a stable API across at least one sprint, genuine LLM independence.

### 6. Small-team orchestration (short-term target)

- The orchestrator-centered flow that today runs **1 LLM : 1 human** (owner + this Orchestrator session) is the foundation for **1 LLM : N humans**.
- Multiple human team members submit requests to the same Orchestrator. The Orchestrator coordinates, resolves conflicts, and dispatches.
- The single entry point is the feature: it forces coherence across team requests that independent LLM sessions cannot.
- Multi-user OS-account isolation is already implemented in agent-console but not activated in daily use. The short-term strategic direction is to close that gap.

## Tone

- We coexist with LLM vendors. We do not attack them.
- We propose "what is healthier for the whole" and let adopters decide.
- When writing about vendor-provided features, describe their scope factually, then describe ours. No rhetoric.

## Prioritization Lens

When evaluating an Issue or proposed work, weigh:

| Axis | Weight |
|---|---|
| **LLM-independence of the mechanism** | High. LLM-neutral platform capabilities beat LLM-specific conveniences. |
| **Extractability of the resulting component** | High. Features that can become future standalone libraries are preferred. |
| **External-stimulus infrastructure** (events, scripts, triggers) | High. This is the backbone of the platform. |
| **Code-replaces-LLM opportunity** | High. Where a script can prepare what an LLM needs, implement the script. |
| **Small-team dimension** (does this help N humans work coherently?) | High short-term. |
| **Scope size** | Low priority — small scope is good, but not by itself a reason to pick a low-value Issue. |
| **Claude-overlap concern** | Zero weight. Overlap is acceptable. |

## Open Questions (evidence-pending, do not freeze)

These are known-unknown. Future Orchestrator sessions should treat them as live topics:

- **Skill-invoked script placement.** Stage 1 (skill-local) is the current default; Stage 2 (monorepo-internal extraction) is not yet triggered. Revisit after 2-3 projects accumulate shared scripts.
- **Distribution channel for extracted components.** npm, binary release, skill catalog, or something else — unresolved.
- **Small-team UX entry point.** Web form, chat integration, memo posting, CLI — the actual intake UX for team members is not designed.
- **Request priority conflict resolution.** How multiple simultaneous human requests are reconciled by the Orchestrator remains open.
- **The specific acceleration blocker** for multi-user activation that owner has flagged. The foundation is implemented; the rollout is stalled on something concrete that needs diagnosis.

## How This Document Evolves

- **Small wording refinements** happen in-place. Commit messages explain.
- **Shift in a core principle** requires an accompanying narrative entry in `docs/narratives/` capturing *why* the shift happened. The principle change alone is incomplete without the story.
- **Addition of a new principle** follows the same pattern: narrative-first (the insight that led to it), then prescriptive addition here.

This document must remain **short and operational**. Length is not a virtue here — it is the thing to resist.
