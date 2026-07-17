# Agent Surface: cross-registry query layer (Issue #1160 PR-A)

## Motivation

AgentConsole has two independent agent registries: `AgentManager` (terminal agents such as Claude Code, backed by `AgentDefinition`) and `EmbeddedAgentManager` (embedded agents that own their own LLM loop, backed by `EmbeddedAgentDefinition`). Three consumer surfaces need to enumerate or resolve agents across both registries: the MCP `list_agents` / `delegate_to_worktree` tools, the REST worktree-creation routes, and the client's agent-selection UI.

Before this design, each consumer that needed cross-registry behavior inlined its own two-registry lookup. The `delegate_to_worktree` MCP tool did this first (PR #1165, a short-term facade fixing Issue #1161), duplicating the same "check terminal, fall back to embedded, reject ambiguous names" logic that would otherwise need to be re-derived at every new consumer. Meanwhile `list_agents` was not updated at all: its tool description says "use this to discover available agents before calling delegate_to_worktree," but it only queried `AgentManager`, so an agent discoverable via `delegate_to_worktree` (an embedded agent, by id or name) was invisible to `list_agents`. This is the parity bug PR-A closes.

The owner's ask (Issue #1160) is cross-surface parity: every surface that lets a user or agent pick an agent should see the same set of agents, presented consistently, without each surface re-inventing the merge logic.

## Why Option A (registry merge) is rejected

The most direct fix for the duplication would be to merge `AgentManager` and `EmbeddedAgentManager` into one registry with one storage shape. This was considered and rejected by the architect (Issue #1160 design discussion) for the same reason the two registries were kept separate in the original embedded-agent-worker design (see [`embedded-agent-worker.md`](embedded-agent-worker.md) § "Naming and shared types"):

- **Disjoint configuration shapes.** `AgentDefinition` describes how to launch and drive a terminal program (command templates, activity-detection patterns, headless-mode template). `EmbeddedAgentDefinition` describes an LLM loop's own configuration (OpenAI-compatible provider, model, system prompt, tool-iteration cap, enabled builtin tools). Neither shape is a subset or superset of the other; a merged type would need a large optional-field surface with cross-field validity rules that don't otherwise exist in the codebase.
- **Non-overlapping id namespaces that must not be confused.** `AgentWorker.agentId` and `EmbeddedAgentWorker.embeddedAgentId` are deliberately separate fields on separate worker-type branches of the `Worker` union. Merging the registries would create pressure to also merge these id fields, which would blur a distinction the worker-type discriminator already encodes cleanly.
- **Independent lifecycle and persistence.** The two registries have different built-in-seeding behavior (`AgentManager` always seeds the Claude Code built-in; `EmbeddedAgentManager` starts empty), different repositories, and different DB tables. A merge would force one lifecycle model onto both.

Given the rejection of a data-model merge, the chosen design (Option B) instead unifies only what consumers can *query*, leaving each registry free to keep its own shape, lifecycle, and persistence.

## Mechanism 1: `AgentKind` single-writer + compile-time exhaustiveness

`AGENT_KINDS = ['terminal', 'embedded'] as const` in `packages/shared/src/types/agent-surface.ts` is the single writer of the kind literals; every consumer derives `AgentKind` from this constant rather than hardcoding a `'terminal' | 'embedded'` union.

The exhaustiveness gate is enforced structurally, not by convention: `AgentDirectory`'s constructor takes `{ [K in AgentKind]: AgentSurface<K> }`, a mapped type keyed by every member of `AgentKind`. If a third kind is ever added to `AGENT_KINDS`, every `AgentDirectory` construction call site becomes a compile error until a matching `AgentSurface` is supplied for the new kind — the type system, not a runtime assertion or a code-review checklist, is what catches an incomplete migration. See "Compile-level exhaustiveness gate evidence" in PR-A's PR body for a captured example of this failure mode.

## Mechanism 2: `AgentSurface` / `AgentDirectory` (Option B, implemented in this PR)

Two new types in `packages/shared/src/types/agent-surface.ts`:

- **`AgentDirectoryEntry`** — a kind-tagged union `{ kind: 'terminal'; agent: AgentDefinition } | { kind: 'embedded'; agent: EmbeddedAgentDefinition }`. Full-fidelity, not a lossy summary projection: consumers narrow on `kind` to recover the concrete definition type they need.
- **`AgentSurface<K>`** — a per-registry read-only query interface: `list()`, `get(id)`, `findByName(name)`, generic over `AgentKind` so a terminal surface's methods are typed to return only terminal entries.

`AgentManager` and `EmbeddedAgentManager` each implement `AgentSurface<'terminal'>` and `AgentSurface<'embedded'>` respectively. The three new methods on each are one-line delegations to their existing `getAllAgents()` / `getAgent()` / `getAgentsByName()` (or the embedded equivalents) — no new logic, no duplicated filtering.

`packages/server/src/services/agent-directory.ts` defines `AgentDirectory`, a stateless composite over one `AgentSurface<'terminal'>` and one `AgentSurface<'embedded'>`:

- `listAll()` — concatenates both surfaces' `list()`, terminal first (stable, documented order). Backs the MCP `list_agents` tool.
- `resolve({ agentId?, agentName? })` — cross-registry resolution, absorbing PR #1165's facade verbatim: an `agentId` checks the terminal surface first, then embedded; an `agentName` collects matches across both surfaces (terminal first) and returns not-found / ambiguous / a single match with the exact same error message strings the facade produced. Backs `delegate_to_worktree`'s agent resolver.

Following the same strict-thin-wrapper discipline documented in [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md) for the privilege-elevation primitives: `AgentDirectory` owns no lifecycle, no caching, and no CRUD. It is constructed fresh (or once, at `AppContext` wiring time) over the live manager instances and reads through to them on every call. Suggestion policy (which agent generates a branch/title suggestion for a delegated worktree) and default-agent policy (`repository.defaultAgentId` fallback) are NOT absorbed into `AgentDirectory` — they stay at the caller (`delegate_to_worktree`'s handler), exactly as the elevation helpers keep ENOENT-tolerance and retry semantics at the caller rather than the primitive.

## Mechanism 3: `AGENT_OPERATIONS` exposure table (planned, PR-D — not yet built)

A future mechanism, out of scope for this PR, will let each MCP tool / REST route declare which `AgentKind`(s) it supports via a static exposure table (working name `AGENT_OPERATIONS`), so a tool surface's actual capability can be checked against the declared table mechanically (the same kind of structural check the tool-surface-symmetry review from Issue #1046 asks about by hand today). This is deferred to PR-D of the Issue #1160 migration; this document does not specify its shape, only reserves the concept so PR-A's audit is not mistaken for having built it.

## Migration order

Issue #1160 is decomposed into four PRs:

- **PR-A (this PR)** — shared types (`AgentKind`, `AgentDirectoryEntry`, `AgentSurface`, `AgentResolution`), `AgentManager` / `EmbeddedAgentManager` implementing `AgentSurface`, the new `AgentDirectory` service, and MCP wiring (`list_agents` gains embedded-agent parity; `delegate_to_worktree`'s inline resolution block is replaced by `AgentDirectory.resolve`).
- **PR-B** — REST routes (`packages/server/src/routes/worktrees.ts`, `routes/workers.ts`) adopt `AgentDirectory` for any cross-registry agent listing/resolution currently duplicated there.
- **PR-C** — client-side agent-selection UI consumes a unified agent list (sourced from the REST/WebSocket surface PR-B exposes) instead of querying two separate endpoints.
- **PR-D** — the `AGENT_OPERATIONS` exposure-table mechanism (Mechanism 3 above), giving each tool/route surface a declared, checkable capability set per `AgentKind`.

## Cross-references

- [Embedded Agent Worker design](embedded-agent-worker.md) — the source of the two-registry split this design builds on top of, without merging.
- [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md) — the strict-thin-wrapper + "extract when two PRs converge" discipline this design's `AgentDirectory` follows.
- Issue [#1160](https://github.com/ms2sato/agent-console/issues/1160) — umbrella tracking PR-A through PR-D.
- Issue [#1161](https://github.com/ms2sato/agent-console/issues/1161) — the original `delegate_to_worktree` embedded-agent-selection gap that PR #1165's short-term facade fixed, and that `AgentDirectory.resolve` now formalizes.
- Issue [#1046](https://github.com/ms2sato/agent-console/issues/1046) — the tool-surface-symmetry process check that Mechanism 3 (PR-D) will make structural.
- PR [#1165](https://github.com/ms2sato/agent-console/pull/1165) — the short-term two-registry facade in `delegate_to_worktree` that this design's `AgentDirectory.resolve` absorbs verbatim.
