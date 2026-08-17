# Embedded Agent SDK Engine

Status: **Draft — normative once merged.** Owner request 2026-08-16 (Issue #1324, owner-designated high priority); design settled 2026-08-17 through Architect/Orchestrator consultation, five owner answers, three empirical probes, and one owner re-acceptance (the memory trade, §2.1). This is a **sibling** to `embedded-agent-worker.md` Part II, not an amendment of it: the two engines are siblings, and the existing engine's normative text is untouched by this document.

## 1. Motivation

**The decisive motivation is authentication, not memory.** Talking to the Messages API directly requires an API key, which forces the product to care about the subscription-vs-API-key distinction at the configuration layer. The Claude Agent SDK removes that fork: the SDK-hosted subprocess runs as the executing user (through the existing `spawnAsUser` harness) and picks up that user's own claude authentication natively — the same auth the user already has for their terminal Claude Code workers. Vendor authentication stays outside the system's scope entirely (see #1325's correction to `shared-orchestrator-session.md`).

A raw Anthropic Messages adapter behind the existing per-turn `ProviderAdapter` interface is **explicitly out of scope** (owner decision, Q5). That interface remains the right shape for such an adapter if one is ever wanted; this feature is not it.

### 1.1 Memory: an accepted cost, not a benefit

The initial memory motivation **reversed under measurement** (all figures from the 2026-08-17 probes, recorded on #1324):

- The SDK's bundled `claude` binary is **byte-identical** (`sha256`) to the installed CLI — the same 307 MB process image, not a lighter runtime.
- Peak RSS: bare `claude -p` ≈ 355 MB; SDK-spawned child ≈ 358–360 MB; SDK host process +89 MB; **SDK combined ≈ 447–449 MB**.
- The existing custom-loop engine measures **92 MB baseline + ~350 KB/turn**.

Two framings, both true and both required wherever this trade is discussed: (a) an SDK-engine worker costs **~4.5× a custom-loop worker**; (b) an SDK-engine worker costs **about what a Claude Code TUI worker already costs** on the same host (~508 MB measured average) — and the 92 MB loop was never available for Claude-without-an-API-key, which is this feature's entire point. The cost is **per-Claude-SDK-worker, not a fleet conversion**: only definitions with the SDK engine discriminant pay it; OpenAI-compatible embedded agents stay on the custom loop.

**Owner re-acceptance (2026-08-17), recorded**: *embedded Claude costs TUI-Claude memory rather than custom-loop memory, and we accept that to remove the API-key fork.*

## 2. Terminology

- **Engine**: the in-subprocess machinery that turns user messages into NDJSON events — the conversation loop, tool execution, and provider communication as one unit.
- **Native-loop engine**: the existing stack — `agent-loop.ts` + `providers/` + `tools/` + `mcp.ts`. Untouched by this document.
- **SDK engine**: a new sibling module hosting a Claude Agent SDK session inside the same subprocess harness.

## 3. The seam — where the fork lives, and where it deliberately does not

**The seam is the existing host↔subprocess stdio/NDJSON protocol, not a new interface.** That protocol is already the single writer of "what an embedded worker means" to everything above it — server lifecycle, output persistence, restore-info, UI events all speak it. The engine fork lives inside the subprocess, at `main.ts`: the init command selects an engine, and both engines emit the **same event vocabulary** upward. Nothing server-side learns a new concept.

What this rules out, with reasons:

- **SDK-as-a-provider** (behind `ProviderAdapter`) — rejected. `ProviderAdapter.run()` is a single model turn; `agent-loop.ts` owns tool execution and the next-turn drive. The Agent SDK owns the loop and tool execution itself, so slotting it behind a per-turn interface means either discarding the SDK's loop or fighting its design. The per-turn interface stays what its header says it is: the shape for a future raw Messages adapter (out of scope, §1).
- **A new worker kind** — rejected. The embedded worker's server-side machinery (persistence, epoch/resync, delivery obligations, UI surfaces) is engine-generic; a new kind would re-open every Q11 surface question for no gain.

### 3.1 Engine selection: a structural discriminant, never inference

The engine is **not user-facing configuration**. There is nothing to choose: for Claude, the SDK is the only embedded path (Q5 removed the alternative), so the engine is determined by **which agent definition the user picks**. The user-facing choice already exists and needs no new concept — at session/worktree creation: Claude Code as a TUI worker, or Claude as an embedded SDK worker, presented through the existing uniform picker with kind badges.

Internally, `EmbeddedAgentDefinition` carries an **explicit engine discriminant** (a definition kind the subprocess dispatch switches on, exhaustively — `satisfies`-style, so a future third engine is a compile error). **Field-presence inference is prohibited** (e.g. "no `provider.apiKey` → SDK engine"): inferring behavior from an absent field is the adaptive-silent-behavior shape rejected in #1291, and here it would make a misconfigured OpenAI-compatible definition silently become an SDK agent.

### 3.2 Authentication property

**In SDK mode, no provider secret crosses the server at all.** The init command's `provider.apiKey` is absent — not optional, absent — for this engine. The subprocess runs as the user; the SDK uses the executing account's own claude configuration, exactly as that user's TUI workers already do. The embedded-agent secrets rule (stdin init only) is untouched; this engine simply has fewer secrets to carry. The MCP dial-back token is still delivered via stdin init and configured into the SDK as an MCP server (§4, tools row).

## 4. Compatibility matrix — subsystem × engine

The recorded #1 bug source in this codebase is the partially-transplanted mechanism. The SDK owns the loop, tools, session persistence, and context compaction — colliding with subsystems the native engine built its own machinery for. Every row below is a decision; none is inherited. Values: **mapped** (same contract, different mechanism), **reimplemented** (same outcome, new mechanism), **accepted-divergence** (differs visibly; owner-accepted), **disabled** (off in this engine, with the consequence stated).

| Subsystem | Native-loop engine | SDK engine | Status |
|---|---|---|---|
| Stdio protocol / NDJSON events | emits directly | SDK stream mapped to the same vocabulary | **mapped** — the event-mapping table is Phase-decomposition work; every native event is classified mapped/approximated/unavailable before implementation |
| Initial-prompt delivery | server-side obligation machinery | same server-side machinery; the delivered prompt becomes the SDK session's first user message | **mapped** |
| Builtin tools (`tools/`) | narrow-ctx subprocess tools | SDK's own tools, constrained via the SDK's allowed-tools config driven from `enabledTools` | **reimplemented** — see §4.1 for the surface ruling |
| Console MCP tools (`mcp.ts` dial-back) | embedded MCP client merges server tools | the dial-back endpoint + stdin-delivered token configured into the SDK as an MCP server | **mapped** — the console-tool surface persists |
| Instruction loader (AGENTS.md / CLAUDE.md) | our 3-layer loader injects into the prompt | **our loader is disabled for this engine**; the SDK reads project instruction files natively | **disabled** — running both would double-load the same files into context; the SDK's native loading is the mechanism, and `instructions?: string[]` extras are delivered via the session seed if configured |
| Context usage display | provider `usage` from the final request | polled from `getContextUsage()` (totalTokens / maxTokens / percentage) after each turn, with the settle guard (§5 H2) | **mapped** |
| Context handoff (#1122) | distill → reset conversation | **auto-compaction OFF** (`settings.autoCompactEnabled: false`, honored at creation and mid-session); OUR threshold read from `getContextUsage()`; handoff executed at the **session boundary** — terminate the SDK session, seed the successor via the `systemPrompt` preset-append with the distillation (recall-tested in the 2026-08-17 probe) | **reimplemented** — the owner's "our handoff stays active" decision, at the mechanism the probe proved |
| Transcript restore (#1123) | NDJSON transcript → conversation rebuild | SDK session resume (the SDK's own session state) | **accepted-divergence** (owner, Q2) — restart durability semantics differ visibly from the native engine's restore banner behavior; the UI consequence is stated at AC time, not discovered |
| Activity states | output-parsing detector | derived from SDK stream events (turn start/end, tool activity) | **mapped** — mapping table decides the exact derivation |
| Turn management (busy/reject) | loop-level TURN_IN_PROGRESS | same NDJSON-level contract enforced by the SDK-engine host around the SDK session | **mapped** |

### 4.1 Tool surface — the inverted parity question, ruled

Embedded-agent v1's lesson (#1042–#1044) was tools we LACKED. The SDK inverts it: its default toolset is a **superset** of our builtins — including WebFetch, WebSearch, and Task/subagents, capabilities embedded v1 **deliberately does not have** while sandboxing (#1045) remains unresolved. The design-time question is therefore "does SDK mode silently grant what we withheld," and the answer is ruled:

**Web tools and subagents are OFF in v1 SDK mode** (owner, Q1). The SDK's allowed-tools configuration is driven from the definition's `enabledTools`, with the withheld set excluded by default. Re-enabling them is a tracked revisit (Issue filed after implementation, per the owner's answer) — a deferral with an address, not a silent drop.

## 5. Named premises and hazards

Per the premise-naming discipline; each entry names what the design cannot survive losing and how it is checked. All empirical entries are **version-premised on SDK 2.1.233** — the probes measured that version, and SDK upgrades re-verify them.

- **PS1 — the SDK honors `settings.autoCompactEnabled: false`** (creation and mid-session via `applyFlagSettings`). Verified at small scale; **NOT verified at a real full window** (~1M tokens was beyond the probe's budget). Recorded as verified-at-small-scale; the handoff E2E at AC time exercises the threshold path with a small window via our own trigger, which is the path production actually uses.
- **PS2 — `getContextUsage()` supplies a usable threshold signal** (totalTokens/maxTokens/percentage). Verified. **Must-not-assume: threshold TUNING of the SDK's own window** — `settings.autoCompactWindow` had no observable effect in the probe (inconclusive, not proven dead). We never needed it (our threshold is our own), but nobody may build on it later without verifying it first.
- **PS3 — session-boundary seeding works**: a successor `query()` with a fresh session id, seeded via `systemPrompt: { type: 'preset', preset: 'claude_code', append: <distillation> }`, recalls the distilled context. Verified with a real recall test. This is what makes the owner's handoff decision implementable regardless of whether the SDK's conversation state is otherwise sealed.
- **H1 (hazard) — memory cost** is §1.1's measured trade; any future claim of SDK-mode memory *savings* is false until re-measured.
- **H2 (hazard) — transport settle race**: calling `getContextUsage()` immediately after a turn's `result` intermittently broke the transport (`ProcessTransport is not ready for writing`); ~300–500 ms of settle fixed it reliably. Encode as **retry-with-settle, not a bare sleep**, and re-verify on every SDK upgrade — this is an empirical workaround for observed 2.1.233 behavior, not a documented contract.

## 6. Non-goals

A raw Messages adapter behind `ProviderAdapter` (Q5; the seam stays shaped for it, unused). Web tools / subagents in v1 (§4.1, tracked revisit). Threshold-tuning of the SDK's own compaction window (PS2). Any change to the native-loop engine, its providers, its tools, or its restore/handoff machinery. Fleet-wide engine conversion (the discriminant scopes cost per-definition). New worker kinds or server-side lifecycle changes.

## 7. Verification floor

- **The event-mapping table is written before implementation** (Phase decomposition), every native NDJSON event classified mapped/approximated/unavailable — the anti-partial-transplant gate for the protocol row of §4.
- **Handoff E2E**: an SDK-engine worker crosses OUR threshold (small window via our own trigger), the session terminates, the successor is seeded, and a recall probe demonstrates continuity — the PS3 probe elevated to a shipping-path test.
- **Auth property test**: the init command serialized for an SDK-engine worker contains no `provider.apiKey` field (structural assert, not absence-by-luck), and the engine functions with only the user's own claude configuration.
- **Tool-surface containment**: an SDK-engine session's effective allowed-tools excludes WebFetch/WebSearch/Task by default (asserted against the SDK's own reported toolset, not our intention).
- **Discriminant exhaustiveness**: compile-level (`satisfies`), plus a test that an OpenAI-compatible definition never dispatches the SDK engine (the #1291-shape containment).
- **H2 regression**: the retry-with-settle path has a test; an SDK upgrade that removes the race makes the retry a no-op, an upgrade that worsens it fails loudly.
- Standard suite/typecheck/preflight; per-file sibling tests per `test-trigger.md`; phasing and per-phase ACs decided with the Orchestrator after this document merges.
