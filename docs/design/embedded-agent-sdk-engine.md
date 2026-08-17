# Embedded Agent SDK Engine

Status: **Draft — normative once merged.** Owner request 2026-08-16 (Issue #1324, owner-designated high priority); design settled 2026-08-17 through Architect/Orchestrator consultation, five owner answers, three empirical probes, and one owner re-acceptance (the memory trade, §2.1). This is a **sibling** to `embedded-agent-worker.md` Part II, not an amendment of it: the two engines are siblings, and the existing engine's normative text is untouched by this document.

## 1. Motivation

**The decisive motivation is authentication, not memory.** Talking to the Messages API directly requires an API key, which forces the product to care about the subscription-vs-API-key distinction at the configuration layer. The Claude Agent SDK removes that fork: the SDK-hosted subprocess runs as the executing user (through the existing `spawnAsUser` harness) and picks up that user's own claude authentication natively — the same auth the user already has for their terminal Claude Code workers. Vendor authentication stays outside the system's scope entirely (see #1325's correction to `shared-orchestrator-session.md`).

A raw Anthropic Messages adapter behind the existing per-turn `ProviderAdapter` interface is **explicitly out of scope** (owner decision, Q5). That interface remains the right shape for such an adapter if one is ever wanted; this feature is not it.

### 1.1 Memory: an accepted cost, not a benefit

The initial memory motivation **reversed under measurement** (all figures from the 2026-08-17 probes, recorded on #1324):

- The SDK's bundled `claude` binary is **byte-identical** (`sha256`) to the installed CLI — the same 307 MB process image, not a lighter runtime.
- Peak RSS per process: bare `claude -p` ≈ 355 MB; SDK-spawned child ≈ 358–360 MB. (The probe's +89 MB "SDK host" was a Node harness artifact — see §3's runtime note; the SDK library loads into the existing Bun subprocess, which in SDK mode also sheds the loop/provider/tool modules.)
- The existing custom-loop engine measures **92 MB baseline + ~350 KB/turn**.
- **Fleet totals use PSS, not RSS** (correction, 2026-08-17, #1332): RSS counts shared pages once per process, and N copies of the same 307 MB binary share their text segment (~160 MB shared per process measured on the live host; PSS 2.13 GB vs RSS 2.60 GB across the readable fleet). `VmHWM` cannot be decomposed into shared/private, so per-process peaks must never be summed into fleet claims. **The marginal cost of one more `claude` process on a host already running some is ~195 MB**, and that is the number that answers "what does one more SDK-engine worker cost".

Two framings, both true and both required wherever this trade is discussed: (a) an SDK-engine worker costs a multiple of a custom-loop worker (~195 MB marginal vs ~92 MB baseline, and ~355 MB peak when it is the only claude on the host); (b) an SDK-engine worker costs **about what a Claude Code TUI worker already costs** — and the 92 MB loop was never available for Claude-without-an-API-key, which is this feature's entire point. The cost is **per-Claude-SDK-worker, not a fleet conversion**: only definitions with the SDK engine discriminant pay it; OpenAI-compatible embedded agents stay on the custom loop.

**Owner re-acceptance (2026-08-17), recorded**: *embedded Claude costs TUI-Claude memory rather than custom-loop memory, and we accept that to remove the API-key fork.*

## 2. Terminology

- **Engine**: the in-subprocess machinery that turns user messages into NDJSON events — the conversation loop, tool execution, and provider communication as one unit.
- **Native-loop engine**: the existing stack — `agent-loop.ts` + `providers/` + `tools/` + `mcp.ts`. Untouched by this document.
- **SDK engine**: a new sibling module hosting a Claude Agent SDK session inside the same subprocess harness.

## 3. The seam — where the fork lives, and where it deliberately does not

**The seam is the existing host↔subprocess stdio/NDJSON protocol, not a new interface.** That protocol is already the single writer of "what an embedded worker means" to everything above it — server lifecycle, output persistence, restore-info, UI events all speak it. The engine fork lives inside the subprocess, at `main.ts`: the init command selects an engine, and both engines emit the **same event vocabulary** upward. Nothing server-side learns a new concept.

**Runtime: the SDK runs in the existing Bun subprocess — never a separate Node host.** The SDK's typed options include `executable?: 'bun' | 'deno' | 'node'` (auto-detected when unspecified) and the package ships Bun-aware loading; the engine passes `'bun'` explicitly rather than trusting auto-detection. The 2026-08-17 probe's +89 MB Node host process was a harness artifact, not an SDK requirement — an implementer who reaches for a Node sidecar pays 89 MB for nothing and adds a process the lifecycle machinery would have to manage.

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
| Process lifetime | as long as the session | **decoupled by design**: SDK session state persists on disk under Claude Code's ownership (`resume`, `listSessions()` / `getSessionInfo()` with `mtime`, JSONL transcripts), independent of process lifetime. The intended consumer is **idle eviction (owner-approved 2026-08-17, embedded-only)**: kill the idle process, `resume` the same session on demand — **lossless**, and a DIFFERENT mechanism from handoff (which is lossy-by-design distillation for a FULL context; the handoff row above must never be read as covering eviction). v1 RESERVES the architecture (spawn goes through the `spawnClaudeCodeProcess` override; the worker persistently carries its SDK session id) and ships NO eviction policy — see §6/§7 | **reserved** — the eviction feature is its own post-v1 phase, gated on PS4 |

### 4.1 Tool surface — the inverted parity question, ruled

Embedded-agent v1's lesson (#1042–#1044) was tools we LACKED. The SDK inverts it: its default toolset is a **superset** of our builtins — including WebFetch, WebSearch, and Task/subagents, capabilities embedded v1 **deliberately does not have** while sandboxing (#1045) remains unresolved. The design-time question is therefore "does SDK mode silently grant what we withheld," and the answer is ruled:

**Web tools and subagents are OFF in v1 SDK mode** (owner, Q1). The SDK's allowed-tools configuration is driven from the definition's `enabledTools`, with the withheld set excluded by default. Re-enabling them is a tracked revisit (Issue filed after implementation, per the owner's answer) — a deferral with an address, not a silent drop.

## 5. Named premises and hazards

Per the premise-naming discipline; each entry names what the design cannot survive losing and how it is checked. All empirical entries are **version-premised on SDK 2.1.233** — the probes measured that version, and SDK upgrades re-verify them.

- **PS1 — the SDK honors `settings.autoCompactEnabled: false`** (creation and mid-session via `applyFlagSettings`). Verified at small scale; **NOT verified at a real full window** (~1M tokens was beyond the probe's budget). Recorded as verified-at-small-scale; the handoff E2E at AC time exercises the threshold path with a small window via our own trigger, which is the path production actually uses.
- **PS2 — `getContextUsage()` supplies a usable threshold signal** (totalTokens/maxTokens/percentage). Verified. **Must-not-assume: threshold TUNING of the SDK's own window** — `settings.autoCompactWindow` had no observable effect in the probe (inconclusive, not proven dead). We never needed it (our threshold is our own), but nobody may build on it later without verifying it first.
- **PS3 — session-boundary seeding works**: a successor `query()` with a fresh session id, seeded via `systemPrompt: { type: 'preset', preset: 'claude_code', append: <distillation> }`, recalls the distilled context. Verified with a real recall test. This is what makes the owner's handoff decision implementable regardless of whether the SDK's conversation state is otherwise sealed.
- **PS4 — `resume` restores a session's conversation faithfully across a process kill.** TYPED-BUT-UNPROBED: the option's documentation says it "loads the conversation history from the specified session", but the 2026-08-17 probe deliberately did NOT exercise `resume` (its session A fully exited with no resume; PS3 tested fresh-session seeding). A typed surface is not verified behavior — the same class as every other should-work claim this project refuses to build on. **PS4 must be probed (kill mid-conversation, resume, recall test) BEFORE the idle-eviction phase's AC is written**; until then the eviction row in §4 stays "reserved", never "supported".
- **H1 (hazard) — memory cost** is §1.1's measured trade; any future claim of SDK-mode memory *savings* is false until re-measured.
- **H2 (hazard) — transport settle race**: calling `getContextUsage()` immediately after a turn's `result` intermittently broke the transport (`ProcessTransport is not ready for writing`); ~300–500 ms of settle fixed it reliably. Encode as **retry-with-settle, not a bare sleep**, and re-verify on every SDK upgrade — this is an empirical workaround for observed 2.1.233 behavior, not a documented contract.

## 6. Non-goals

A raw Messages adapter behind `ProviderAdapter` (Q5; the seam stays shaped for it, unused). Web tools / subagents in v1 (§4.1, tracked revisit). Threshold-tuning of the SDK's own compaction window (PS2). Any change to the native-loop engine, its providers, its tools, or its restore/handoff machinery. Fleet-wide engine conversion (the discriminant scopes cost per-definition). New worker kinds or server-side lifecycle changes.

**Idle eviction is deferred to its own post-v1 phase, deliberately — with the architecture reserved in v1.** The mechanism's plumbing overlaps this engine's (`spawnClaudeCodeProcess` override, persisted session id), so v1 pays the two cheap structural costs that make eviction a later small PR instead of a re-cut: every spawn goes through the override point, and the worker's SDK session id is persisted. What v1 does NOT ship is the eviction FEATURE, for three reasons stated rather than implied: its mechanism premise (PS4, `resume` fidelity) is typed-but-unprobed and policy must not be built on an unprobed mechanism; its policy surface (idle threshold, wake-latency budget, whether a restoring worker shows an explicit UI state) is product-visible and benefits from real embedded-SDK usage data that does not exist yet; and it delivers zero immediate savings — every claude process on the host today is a TUI worker, which the owner excluded (the PTY IS the user's terminal; killing it is visible). The deferral has an address: the eviction phase follows v1 dogfood, gated on the PS4 probe.

## 7. Verification floor

- **The event-mapping table is written before implementation** (Phase decomposition), every native NDJSON event classified mapped/approximated/unavailable — the anti-partial-transplant gate for the protocol row of §4.
- **Handoff E2E**: an SDK-engine worker crosses OUR threshold (small window via our own trigger), the session terminates, the successor is seeded, and a recall probe demonstrates continuity — the PS3 probe elevated to a shipping-path test.
- **Auth property test**: the init command serialized for an SDK-engine worker contains no `provider.apiKey` field (structural assert, not absence-by-luck), and the engine functions with only the user's own claude configuration.
- **Tool-surface containment**: an SDK-engine session's effective allowed-tools excludes WebFetch/WebSearch/Task by default (asserted against the SDK's own reported toolset, not our intention).
- **Discriminant exhaustiveness**: compile-level (`satisfies`), plus a test that an OpenAI-compatible definition never dispatches the SDK engine (the #1291-shape containment).
- **H2 regression**: the retry-with-settle path has a test; an SDK upgrade that removes the race makes the retry a no-op, an upgrade that worsens it fails loudly.
- Standard suite/typecheck/preflight; per-file sibling tests per `test-trigger.md`; phasing and per-phase ACs decided with the Orchestrator after this document merges.

## Appendix A — event-mapping table (Gate 0, authored 2026-08-17)

This table is the pre-implementation gate named in §7: every native NDJSON command and event, classified against the SDK's stream BEFORE any engine code exists, so no implementer writes the contract while building against it. Source of the native vocabulary: `packages/shared/src/types/embedded-agent.ts` (`EmbeddedAgentCommand` / `EmbeddedAgentEvent` / `EmbeddedAgentServerEvent`), read at `a8d04fa3`.

**Verification split, honoring Q12 without another probe round**: this table pre-commits the TARGET (which native event each SDK signal becomes). The SOURCE side (exact SDK type/flag names) is typed surface on 2.1.233 — Phase 1's implementer CONFIRMS each `verify` -marked row against the real stream before coding that mapping; any mismatch is STOP-and-consult and the table is amended with a correction trail, never silently diverged from.

### A.1 Commands (stdin → engine)

| Native command | SDK engine handling | Class |
|---|---|---|
| `init` | Construct the `query()` options: system-prompt append, allowed-tools from `enabledTools` (§4.1 exclusions), MCP dial-back as an SDK MCP server, `settings.autoCompactEnabled: false`, `executable: 'bun'`, no `resume` (PS4 gate). `provider.apiKey` absent by construction (§3.2) | mapped |
| `user-message` | Next user turn into the live SDK session | mapped — `verify`: the streaming-input mechanism for a follow-up turn on 2.1.233 |
| `cancel` | SDK interrupt | mapped — `verify`: the interrupt call's behavior on partial output (what the stream emits after an interrupt) |
| `handoff` | Engine-level: distill → terminate session → seed successor (PS3 mechanism; Phase 2) | reimplemented |
| `shutdown` | Terminate the SDK session and child process; stdin-sink teardown per the feeding-consumer rules | mapped |

### A.2 Events (engine → stdout)

| Native event | SDK source | Class |
|---|---|---|
| `ready` | Emitted after the SDK session's init/system message is received (session is accepting input) | mapped |
| `state` (`active`/`idle`) | Derived: `active` on the first stream signal of a turn, `idle` on the turn's `result` | mapped (derived) |
| `assistant-delta` | Partial-message stream: text delta blocks | mapped — `verify`: the partial-messages option name and delta event shape |
| `assistant-thinking-delta` | Partial-message stream: thinking delta blocks | mapped — same `verify`; additionally model-config-dependent (absent when the model emits no thinking), which matches the native event's own no-terminal-counterpart caveat |
| `assistant-message` | The assistant message's final text content | mapped |
| `tool-call` | Assistant-message `tool_use` block (id, name, input) | mapped, with a SEMANTIC note: in the native engine this event precedes OUR executor running the tool; in the SDK engine the SDK executes the tool itself and the event is observational. Downstream consumers only render, so the contract holds — but no host code may treat it as a request to execute |
| `tool-result` | User-message `tool_result` block (`ok` = not `is_error`; result stringified, native length caps applied) | mapped |
| `turn-error` | The turn's `result` in an error subtype, or an SDK-raised turn failure | approximated — the error-classification granularity differs; Phase 1 maps the enumerable subtypes and folds the rest into a generic `turn-error`, listing the observed subtypes in the PR body |
| `fatal` | Transport/process-level failure (spawn failure, transport closed unexpectedly, H2's race exhausting its retries) | mapped |
| `context-usage` | NOT the per-turn `result` usage: polled via `getContextUsage()` post-turn with retry-with-settle (H2); `promptTokens` ← `totalTokens`, `estimated: false` | mapped (Phase 2) |
| `context-handoff` | Engine-authored at handoff execution, exactly as the native engine authors its own | identical (engine-authored, never SDK-derived) |

### A.3 Server-side events (engine-agnostic)

`user-message` (server echo) and `exited` are appended by the SERVER, not the subprocess — unchanged for both engines by construction. No row needed beyond this note; listing them here prevents a future reader from hunting for their SDK mapping.

### A.4 Coverage statement

Every member of `EmbeddedAgentCommand` and `EmbeddedAgentEvent` at `a8d04fa3` appears above; nothing is classified `unavailable`. The two `approximated` degrees of freedom (turn-error granularity; thinking-delta model dependence) carry their consequences in place. If the shared union gains a member, this table gains a row in the same PR — the union and the table are a mirror pair.
