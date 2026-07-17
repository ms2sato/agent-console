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

## Mechanism 3: `AGENT_OPERATIONS` exposure tables (implemented, PR-D)

Mechanisms 1 and 2 answer "can a consumer query both registries uniformly, and does an omitted `AgentKind` fail the build?" They do **not** answer a structurally different question: does every consumer *surface* (UI, MCP, embedded-agent-visible) expose the *same set of operations* on agents, or does one surface silently drift ahead of or behind the others? That was the concrete symptom that opened Issue #1160: `list_agents` (MCP) listed terminal agents only while `delegate_to_worktree` (also MCP) already accepted embedded ids — a same-surface, cross-*operation* parity gap that Mechanisms 1/2 have no way to catch, because both operations query the same registries correctly in isolation.

### The single-writer operation enum

`AGENT_OPERATIONS` (`packages/shared/src/types/agent-operations.ts`) is the single writer of every cross-surface agent operation:

```ts
export const AGENT_OPERATIONS = [
  'listAgents',             // enumerate selectable agents
  'resolveAgent',           // ref (id/name) -> definition, incl. ambiguity handling
  'createSessionWithAgent', // new worktree session with an initial agent worker
  'addWorkerToSession',     // add an agent worker to an existing session
  'manageDefinitions',      // CRUD on agent definitions
] as const;
export type AgentOperation = (typeof AGENT_OPERATIONS)[number];

export type SurfaceExposure =
  | { exposed: true; via: string }      // entry point, human-locatable
  | { exposed: false; reason: string }; // explicit opt-out with rationale
```

An operation belongs in this enum when a user or agent can perform it against "an agent" through more than one surface, or when its absence from a surface must be an explicit recorded decision rather than silence.

### One exposure table per surface, `satisfies Record<AgentOperation, SurfaceExposure>`

Each surface owns its own table, colocated with that surface's code:

| Table | File |
|---|---|
| UI | `packages/client/src/lib/agent-operations-ui.ts` |
| MCP | `packages/server/src/mcp/agent-operations-mcp.ts` |
| Embedded-visible | `packages/server/src/mcp/agent-operations-embedded.ts` |

The `satisfies Record<AgentOperation, SurfaceExposure>` typing is the compile-time gate: adding a sixth operation to `AGENT_OPERATIONS` fails the build in every one of these tables until that table records an explicit `{ exposed: true; via }` or `{ exposed: false; reason }` entry for it. Types cannot force a UI affordance to exist -- they *can* force the omission to be a recorded decision instead of silence.

### Initial content (verbatim from the architect's spec, Issue #1160)

| Operation | UI | MCP | Embedded-visible |
|---|---|---|---|
| `listAgents` | pickers + /agents page | `list_agents` (both kinds after PR-A) | same MCP tool via /mcp endpoint |
| `resolveAgent` | picker selection | `delegate_to_worktree` agentId/agentName | same |
| `createSessionWithAgent` | CreateWorktreeForm | `delegate_to_worktree` | same |
| `addWorkerToSession` | AddAgentWorkerMenu | `not-exposed`: delegate model is one-worktree-one-session; adding workers to foreign sessions crosses the #878 auth boundary | same |
| `manageDefinitions` | /agents page + settings | `not-exposed`: definition CRUD is an owner/console concern, not a delegation concern | same |

Two honesty notes, carried over from the spec:

- **The embedded-visible surface is structurally identical to the MCP surface.** Embedded agents reach the same `/mcp` endpoint with a token; there is no caller-specific tool filter for these operations (the settled premise behind the embedded-agent-worker design's builtin-tool gating, which is a *separate*, already-solved concern via `EMBEDDED_AGENT_TOOL_NAMES`). `agent-operations-embedded.ts`'s table is therefore mostly `via: 'MCP endpoint (shared) — <tool name>'`, and its sibling test asserts `exposed` parity against the MCP table operation-by-operation -- a drift between the two tables is a bug, not a design choice, so it fails a test rather than requiring a reviewer to notice.
- **Mechanical checking is applied where the claim is checkable, review where it is not.** The MCP and embedded-visible tables' `via` claims name a real registered MCP tool, so `packages/server/src/mcp/__tests__/agent-operations-mcp.test.ts` and `agent-operations-embedded.test.ts` parse `mcp-server.ts`'s actual tool registrations and assert every `exposed: true` claim names one that exists. The UI table's `via` claims name a component/page, which has no equivalent single source of truth to parse against without excessive coupling to file layout -- accuracy there stays a review-time judgment call. This division is the Option-D residue the process-rule extension below names explicitly: types and mechanical tests shrink what a reviewer must check by hand, they don't eliminate the need for judgment entirely.

### Process-rule residue

Whatever an exposure table's `satisfies` typing and mechanical tests cannot catch -- whether a `via`/`reason` claim is *accurate*, whether a newly-introduced surface remembered to add its own table at all -- is handled by `.claude/rules/pre-pr-completeness.md` Q11's extension (sub-question 5), which extends the pre-existing tool-surface-symmetry check from Issue #1046 to this operation-level parity. The goal, as with Mechanisms 1 and 2, is to shrink the review-by-convention surface to only what types and tests genuinely cannot enforce.

## Uniform listing principle (client convergence, PR-C)

Owner directive, dated 2026-07-17, binding for future work on any agent-selection surface (not only the ones this PR touches):

> Any surface that presents agents as a list shows every `AgentKind` uniformly; kind-scoping is legitimate only when the concept exists for one kind.

"Uniform" means every `AgentKind` is visible in the same list, in the same interaction model, with the same presentation conventions (`AGENT_KIND_PRESENTATION`, `packages/client/src/components/agents/agentKindPresentation.ts`). It does NOT mean every kind must be equally *actionable* in every context: a kind may be shown but disabled with an explanatory notice (`AgentKindNotice`) when the underlying operation genuinely does not support that kind yet (see the restart-dialog example below). What uniformity forbids is silently omitting a kind from a list for presentation convenience.

"Kind-scoping is legitimate only when the concept exists for one kind" means a picker may show only one `AgentKind` when the thing it configures is inherently tied to that kind's data model -- not merely because the author didn't get around to adding the other kind. `AgentForm`'s `baseAgentId` preset picker is the reference example: presets are a property of `AgentDefinition` (terminal agents) with no `EmbeddedAgentDefinition` analog, so scoping that picker to terminal is a genuine concept boundary, not an oversight.

### Surface inventory (as audited in PR-C)

| Surface | Status | Rationale |
|---|---|---|
| `UnifiedAgentSelector` in `CreateWorktreeForm.tsx` | uniform | Both kinds shown, both fully selectable, neither disabled. Pre-existing since PR #1058/#1038; PR-C only migrated it onto `useAgentDirectory` + the discriminated `AgentSelection` type without changing its behavior. |
| `UnifiedAgentSelector` in `QuickSessionForm.tsx` | uniform | PR-C change: both kinds shown and selectable (owner decision (a)). Default selection stays the terminal default agent (`useResolvedAgentId`) -- the uniform-listing principle governs what the picker *shows*, not what it defaults to; embedded agents never auto-select. |
| `AddAgentWorkerMenu.tsx` | uniform | Shell (not an `AgentKind` -- a plain terminal worker with no agent) is always first, followed by every terminal and every embedded agent, each carrying a kind badge from `AGENT_KIND_PRESENTATION`. Unaffected in behavior by PR-C; badges now source from the single-writer presentation table instead of inline markup. |
| `UnifiedAgentSelector` in `RestartSessionDialog.tsx` | uniform-with-restriction-notice | PR-C change (owner decision (c)): embedded agents are now visible in the list (previously invisible, base `AgentSelector` was terminal-only) but rendered `disabled`, with `AgentKindNotice` explaining that cross-type restart isn't supported server-side yet (#1171, blocked on #1123 transcript restore). Terminal selection behavior is unchanged. It is structurally impossible for a submit to carry an embedded id: `RestartWorkerRequestSchema` has no `embeddedAgentId` field, and only a `{ kind: 'terminal' }` selection ever reaches `setSelectedAgentId`. |
| `AgentForm.tsx` `baseAgentId` preset picker | kind-scoped-by-concept (legitimate) | Presets (`AgentDefinition.baseAgentId`) are a terminal-only concept; `EmbeddedAgentDefinition` has no preset mechanism. Unchanged by PR-C. |
| `EditRepositoryForm.tsx` `defaultAgentId` setting | kind-scoped-by-concept (legitimate for now) | The server contract (`Repository.defaultAgentId`) consumes this as a terminal agent id for headless-suggestion / delegate-default policy. Widening it to accept an embedded id is a server-contract change and explicitly out of scope for a client-only PR. Noted here as a possible follow-up, not implemented. |
| `routes/agents/index.tsx` (`/agents` management page) | management | Already lists both kinds, each in its own full-CRUD section (`TerminalAgentsSection` / `EmbeddedAgentsSection`, added by PR #1029/#1031). Not a picker; the uniform-listing principle is satisfied at the page level (both kinds are one page-scroll away) rather than within one list. Unaffected by PR-C. |
| `routes/settings/index.tsx` (`/settings` page) | **flagged, deferred** | Lists only terminal agents (its own `AgentCard`/`unregisterMutation` duplicate of `TerminalAgentsSection`), predating the `/agents` management page. No embedded-agent section exists here. This is a genuine gap under the uniform-listing principle with no concept-level justification found -- but extending it duplicates a large amount of already-built CRUD wiring (`AddEmbeddedAgentForm`, `EditEmbeddedAgentForm`, `EmbeddedAgentDeleteDialog`) into a second page, or alternatively the page's agent-management section should be deprecated in favor of `/agents`. Either resolution is a product decision beyond a client-only picker-convergence PR's scope; PR-C leaves it unresolved and flags it for owner/architect decision (see PR body). |
| `SessionPage.tsx` `useAgents()` | not a list surface | Used only to look up `stripScrollbackClear` on the *active* worker's terminal agent (`activeWorker.type === 'agent'` branch); never renders a list. `stripScrollbackClear` has no embedded-agent analog (PTY scrollback semantics don't apply to the embedded LLM-loop worker type), so this is not subject to the uniform-listing principle at all. |

## Migration order

Issue #1160 is decomposed into four PRs:

- **PR-A** — shared types (`AgentKind`, `AgentDirectoryEntry`, `AgentSurface`, `AgentResolution`), `AgentManager` / `EmbeddedAgentManager` implementing `AgentSurface`, the new `AgentDirectory` service, and MCP wiring (`list_agents` gains embedded-agent parity; `delegate_to_worktree`'s inline resolution block is replaced by `AgentDirectory.resolve`).
- **PR-B** — REST routes (`packages/server/src/routes/worktrees.ts`, `routes/workers.ts`) adopt `AgentDirectory` for any cross-registry agent listing/resolution currently duplicated there.
- **PR-C (this PR)** — client-only convergence. `packages/client/src/hooks/useAgentDirectory.ts` merges the client's existing two per-registry queries (`useAgents` / `useEmbeddedAgents`) into one `AgentDirectoryEntry[]` (terminal first, then embedded -- mirroring the server's `AgentDirectory.listAll()` order). The non-discriminated `{ agentId?; embeddedAgentId? }` selection shape is replaced by a discriminated `AgentSelection` union (client-local UI state, not a wire type) so an invalid "both set" / "neither set" state is unrepresentable. `WorktreeAgentSelector` is renamed `UnifiedAgentSelector` and adopted uniformly by `QuickSessionForm` and (visible-but-disabled for embedded) `RestartSessionDialog`. A single-writer presentation table (`AGENT_KIND_PRESENTATION`) replaces per-component inline badge/optgroup markup. PR-C required **no wire or schema change**: `CreateQuickSessionRequestSchema` already carried `embeddedAgentId` (mutually exclusive with `agentId` via a `v.check`) since before this migration, so the client-side widening of `QuickSessionForm` to accept embedded selections needed only client code. This is a narrower mechanism than originally sketched ("consumes a unified agent list sourced from the REST/WebSocket surface PR-B exposes") -- PR-B's server-side `AgentDirectory` adoption did not add a new cross-registry REST/WS endpoint for the client to consume, so PR-C merges client-side instead, over the two endpoints that already existed.
- **PR-D (this PR)** — the `AGENT_OPERATIONS` exposure-table mechanism (Mechanism 3 above): the shared `AgentOperation` / `SurfaceExposure` types, the UI / MCP / embedded-visible tables, the MCP-table mechanical cross-check tests, and the `pre-pr-completeness.md` Q11 process-rule extension. Closes Issue #1160.

## Cross-references

- [Embedded Agent Worker design](embedded-agent-worker.md) — the source of the two-registry split this design builds on top of, without merging.
- [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md) — the strict-thin-wrapper + "extract when two PRs converge" discipline this design's `AgentDirectory` follows.
- Issue [#1160](https://github.com/ms2sato/agent-console/issues/1160) — umbrella tracking PR-A through PR-D.
- Issue [#1161](https://github.com/ms2sato/agent-console/issues/1161) — the original `delegate_to_worktree` embedded-agent-selection gap that PR #1165's short-term facade fixed, and that `AgentDirectory.resolve` now formalizes.
- Issue [#1046](https://github.com/ms2sato/agent-console/issues/1046) — the tool-surface-symmetry process check that Mechanism 3 (PR-D) extends from tool-level to operation-level parity.
- [`pre-pr-completeness.md`](../../.claude/rules/pre-pr-completeness.md) Q11 sub-question 5 — the process-rule residue for exposure-table accuracy that Mechanism 3's types and mechanical tests cannot enforce.
- PR [#1165](https://github.com/ms2sato/agent-console/pull/1165) — the short-term two-registry facade in `delegate_to_worktree` that this design's `AgentDirectory.resolve` absorbs verbatim.
- Issue [#1171](https://github.com/ms2sato/agent-console/issues/1171) — server-side cross-type restart (embedded-agent restart support), the prerequisite for `RestartSessionDialog`'s embedded entries to become selectable instead of disabled-with-notice. Blocked on Issue #1123 (conversation transcript restore).
