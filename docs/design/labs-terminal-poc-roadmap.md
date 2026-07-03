# Labs Terminal PoC Promotion Roadmap

Refs: [#722](https://github.com/ms2sato/agent-console/issues/722) (renderer re-evaluation gate), [PR #934](https://github.com/ms2sato/agent-console/pull/934) (working PoC).

This document is the specification for promoting the `labs/terminal-poc` renderer (`@xterm/headless` VT core + custom React DOM renderer + module-scope external store) from a research PoC to the production terminal, eventually replacing `packages/client/src/components/Terminal.tsx` and its satellite cache layer. It contains the full feature inventory of the current integration, a gap classification, a staged PR plan, the instance-memory-management design, the fallback path, and the regression verification plan.

**Line references** to `Terminal.tsx` and satellites are as of main at the time of writing (post-#930); references to `labs/terminal-poc/*` are as of PR #934 (`ba0e6ac`).

## Invariants (the design core — every promotion PR must preserve these)

1. **The VT instance outlives React mounts.** The headless Terminal + WebSocket live in a module-scope store keyed by `sessionId:workerId`; React components only subscribe via `useSyncExternalStore`. Tab switches and route navigation reuse the live buffer.
2. **No serialize/restore layer.** Terminal state is re-readable data (`buffer.getLine(y).getCell(x)`), never an ANSI-stream snapshot. The IndexedDB cache family (`terminal-state-cache.ts`, `terminal-state-save-manager.ts`, `terminal-chunk-writer.ts`) must not be ported — its concern disappears structurally.
3. **Public API only.** Rendering is our own React code reading the documented buffer API. No private-member access (`_core`, `_renderService`), no render forcing, no monkey-patching.
4. **No mount/dispose rituals.** The React component holds no terminal resource; no `MutationObserver` waiting for library DOM, no `setTimeout(0)` dispose deferral, no mount-generation stale guards.
5. **Mobile primitives are first-class.** Layout is driven by `visualViewport`, scrolling is a native `overflow-y: auto` container, IME input goes through composition events.
6. **State restoration builds on AgentConsole's existing persistence, never on serialized terminal state.** The source of truth is the server-side output persistence (`packages/server/src/lib/worker-output-file.ts` file-backed output + the WebSocket `request-history` offset catch-up served via `worker-lifecycle-manager.ts:698` `readHistoryWithOffset`). Restoration paths: **connection lost → server catch-up stream** (offset delta); **tab/route switch → the long-lived instance** (invariant 1); and, as a **cold-start (full page reload) optimization, an IndexedDB mirror of the raw output stream + offset is permitted** (owner direction, 2026-07-02 — clarified from an earlier server-only phrasing). The mirror is a byte-for-byte client copy of the server's output file, reconciled by the same offset/truncation protocol as reconnect — fundamentally different from the retired serialize layer. What stays prohibited is invariant 2's target: snapshotting *parsed* terminal state (SerializeAddon-style), which is where the old 788-line complexity came from. Whether the mirror is worth adding is decided by PR-1's cold-start measurement, not preemptively.

If a promotion PR cannot implement a legacy feature without breaking one of these, the feature gets redesigned (or consciously dropped), not the invariant.

## Feature inventory and gap classification

Sources audited: `Terminal.tsx` (1033 lines), `terminal-state-cache.ts` (250), `terminal-state-save-manager.ts` (357), `terminal-chunk-writer.ts` (181), `render-diagnostics.ts` (191), `useTerminalWebSocket.ts` (100), `terminal-utils.ts` (88), plus the integration surface in `SessionPage.tsx:509-519` and the singleton layer `worker-websocket.ts` / `usePersistentWebSocket.ts` / `websocket-reconnect.ts`.

Classification legend:

- **covered** — works in the PoC today.
- **missing** — must be implemented during promotion.
- **redesign** — the concern remains but its implementation must change shape to fit the invariants.
- **structurally n.a.** — the problem the code solved cannot occur in the new architecture; port nothing.

### A. Protocol and lifecycle

| Feature | Current location | Status | Notes |
|---|---|---|---|
| WS connect / input / resize / request-history | `worker-websocket.ts:439-593` | covered | PoC store speaks the same protocol (own connection). |
| Reconnect with exponential backoff + jitter, close-code classification | `websocket-reconnect.ts:27-47`, `worker-websocket.ts:133-214` | redesign | PoC uses fixed 1.5s x 10. Promotion reuses `getReconnectDelay` / `shouldReconnect` (shared lib, import as-is) inside the store. |
| Incremental history via offset (`fromOffset`) | `Terminal.tsx:857-866`, `offsetRef` | redesign | PoC always requests offset 0 on a new connection. With a live instance, the offset's only remaining job is cheap re-sync after a WS drop: track last received offset in the store, request `fromOffset=offset` on reconnect. The cache-restore half of the old logic disappears (invariant 2). |
| Server-side truncation resync (offset regression detection) | `Terminal.tsx:242-256` | missing | When the history response offset is lower than requested, reset the headless buffer and treat as full history. Small, testable store logic. |
| `output-truncated` message (banner + offset bump) | `Terminal.tsx:314-328`, `worker-websocket.ts:264-290` | missing | Store updates offset; UI shows a dismissible banner. The cache-clearing half is n.a. |
| `exit` handling + exit info UI | `Terminal.tsx:284-287`, route `ExitBanner` | covered | Store preserves `exited` through socket close (fixed in #934 review round). |
| `worker-restarted` app event (reset + reconnect) | `Terminal.tsx:331-364` | missing | Store must subscribe to app-WS worker-restarted (or receive it via an adapter), `terminal.reset()`, clear row cache, reset offset, reconnect, show notification banner. |
| `server-restarted` message (PID tracking) | `worker-websocket.ts:291-301`, `terminal-state-cache.ts:53-75` | structurally n.a. | Existed for cache-staleness observability. With no cache, nothing to invalidate; log and move on. |
| `activity` events → sidebar / parent | `Terminal.tsx:300-302`, `useTerminalWebSocket.ts:11` | missing | Pass through store → adapter `onActivityChange`. Needed for the sidebar activity dots and asking-state UX. |
| Worker error codes → recovery UI | `useTerminalWebSocket.ts:36-47`, `Terminal.tsx:931-941`, `WorkerErrorRecovery` | missing | Store surfaces `{message, code}`; the existing `WorkerErrorRecovery` component is reused as-is (it is renderer-agnostic). SESSION_DELETED / SESSION_PAUSED must also stop reconnection (`worker-websocket.ts:253-262` semantics). |
| Session delete mutation + navigation on unrecoverable error | `Terminal.tsx:143-168` | missing | Moves to the adapter component (integration phase), unchanged behavior. |

### B. Rendering and scrolling

| Feature | Current location | Status | Notes |
|---|---|---|---|
| ANSI / truecolor / 256-palette / CJK / emoji | xterm.js core | covered | Same parser core; verified in PR #934 QA (Claude Code TUI, CJK both directions). |
| Scrollback + auto-scroll pinning + jump-to-bottom | `Terminal.tsx:175-215`, `isScrolledToBottom` | covered | Native scroll container; PoC keeps position on scroll-up. |
| **Mobile scroll visual feedback (scroll position indicator)** | desktop-only in current terminal (browser scrollbar on `.xterm-viewport`; invisible on mobile) | covered (fast-tracked) | **Owner-reported gap (2026-07-02): during touch scroll nothing indicates position/motion on mobile.** Fast-tracked ahead of this roadmap as an iOS-style fade-in indicator (`PocScrollIndicator.tsx`) — appears while scrolling, fades 800ms after the last scroll event, hidden when content does not overflow. This is strictly better than the desktop-browser-scrollbar baseline, which mobile browsers do not render for custom containers. |
| Scroll-position corruption recovery (`distanceFromBottom` via wheel) | `Terminal.tsx:71-87, 724-731` | structurally n.a. | Existed because xterm's `viewportY` corrupts across alt-screen transitions / render stalls. The browser owns scroll position now; touch and wheel both work natively. |
| Render stall watchdog + `_isPaused` recovery | `Terminal.tsx:442-523` | structurally n.a. | The private-API monkey-patch family. React renders from data; there is no render pipeline to force. |
| `.xterm-viewport` MutationObserver + triple scroll listeners | `Terminal.tsx:744-782` | structurally n.a. | Our scroll container is our own DOM. |
| Deferred dispose ritual | `Terminal.tsx:832-845` | structurally n.a. | Component holds no terminal resource. |
| Fit-to-container (FitAddon + window.resize + connected-fit) | `Terminal.tsx:417-418, 621-633, 659-665, 850-855` | covered | ResizeObserver + measured cell size, padding-corrected (#934 review round). |
| Render diagnostics watchdog (localStorage-gated) | `render-diagnostics.ts`, `Terminal.tsx:437-440` | redesign (optional) | The stall class it was built to diagnose is gone. If diagnostics are still wanted, a store-level counter (writes/notifies per interval) is trivial to expose. Default: drop; revisit on demand. |
| Chunked history writes with ANSI-safe split points | `terminal-chunk-writer.ts` | structurally n.a. | History is written into an off-DOM buffer; there is no per-chunk paint cost to manage. Perf item PR-1 verifies large-history write time. |

### C. Cache and persistence (the 788-line family)

| Feature | Current location | Status | Notes |
|---|---|---|---|
| IndexedDB save/load/expiry, PID keys | `terminal-state-cache.ts` (250) | structurally n.a. | Invariant 2. |
| Idle-based save manager (dirty marks, unregister-save) | `terminal-state-save-manager.ts` (357) | structurally n.a. | Invariant 2. |
| SerializeAddon + save-after-history + 4-fold stale guards | `Terminal.tsx:186-209, 427-435, 525-619` | structurally n.a. | Invariant 2/4. |
| Tab-switch flicker avoidance | (the cache's raison d'etre, #648) | covered | The live instance IS the cache. Verified in dogfood: return-to-tab renders instantly. |
| Full-page-reload cold start | cache restore path | redesign | After browser reload the module store is empty; full history is re-requested and written off-DOM. PR-1 must verify this path meets or beats the old cold-start (#648's ~20s pathology came from *rendering* the replay; off-DOM parse is orders faster). |

### D. Input and interaction

| Feature | Current location | Status | Notes |
|---|---|---|---|
| Keyboard input | `Terminal.tsx:636-638` | covered | Hidden textarea; keydown → escape sequences. |
| **Mouse reporting to the TUI (click-to-focus inside TUI screens, in-app wheel scroll)** | xterm.js built-in "mouse events mode" (no app code in `Terminal.tsx` — comes with `terminal.open()`; see `@xterm/xterm` d.ts `disableStdin`/mouse-events notes) | missing | **Owner-reported PoC gap (2026-07-02): text can be typed into a TUI, but tapping a TUI input field cannot direct focus to it.** The existing terminal works because xterm.js encodes pointer events into SGR/X10 mouse sequences whenever the app enables DECSET mouse tracking; TUIs (Claude Code, vim, lazygit) route those clicks internally. The PoC's only pointer handling is `PocTerminalView.tsx:134` `onPointerDown={onRequestFocus}` — it focuses the hidden textarea and encodes nothing. Implementation route: `@xterm/headless` publicly exposes `terminal.modes.mouseTrackingMode` (`'none' \| 'x10' \| 'vt200' \| 'drag' \| 'any'`, d.ts line 1323); the view converts pointer/wheel coordinates to cell coordinates (cell metrics are already measured for resize) and the store encodes SGR mouse reports when tracking is active. Wheel/touch in alt-screen was fast-tracked into #934 after owner dogfood (mode-aware forwarding: SGR wheel reports under mouse tracking, DECCKM-aware arrows otherwise; buffer type via `buffer.active.type` + `onBufferChange`); the remaining PR-2 work is click/tap-to-focus reporting itself. |
| Shift+Enter soft newline | `Terminal.tsx:648-654` | covered | |
| IME composition | `Terminal.tsx:643-645` (skip-only) | covered+ | PoC adds composition preview; send-on-compositionend. Real-device iOS/Android IME verification still pending (owner dogfood item). |
| Text paste | xterm default handler | redesign | PoC sends textarea input verbatim. Promotion must implement **bracketed paste mode** honoring the app's DECSET 2004 state (the VT core tracks modes; check `terminal.modes.bracketedPasteMode`) — multi-line paste into Claude Code's asking-state is a known fragile point (lesson: #792/#793, and #935's D' work). |
| Text selection + copy | none (xterm built-in selection) | missing | **The DOM renderer gets native browser selection for free** — a structural advantage over canvas/xterm. Work: verify cross-row selection produces sane clipboard text (row divs join with `\n`, trailing-blank trimming already helps), scope Cmd+A to the terminal container, and adopt the D' semantics from #935 (Cmd+A → select terminal content; option-click behaviors are xterm-specific and n.a. in a DOM renderer). |
| Image paste → `onFilesReceived` | `Terminal.tsx:668-687` | missing | Capture-phase paste listener with image extraction, forwarding to `MessagePanel.addFiles` (`SessionPage.tsx:516`). Port nearly verbatim to the adapter. |
| Drag & drop files + overlay | `Terminal.tsx:689-719, 968-973` | missing | Same port. |
| Clickable links (WebLinksAddon) | `Terminal.tsx:420-425` | missing | In a DOM renderer this is URL detection over row text → `<a>` (or click handler) — simpler and safer than the addon (`noopener,noreferrer` preserved). |
| Output filters (`stripSystemMessages`, `stripScrollbackClear`) | `Terminal.tsx:92-107`, `terminal-utils.ts:62-88` | covered (fast-tracked) | Fast-tracked into #934 after owner dogfood surfaced that Claude Code's CSI 3J redraws left nothing to scroll: the PoC reuses the production filters, always-on. The remaining PR-1 work is making `stripScrollbackClear` conditional per agent config (flag arrives through the adapter, `SessionPage.tsx:434-438`). |

### E. Integration surface

| Feature | Current location | Status | Notes |
|---|---|---|---|
| `TerminalProps` contract (7 props) | `Terminal.tsx:44-54`, consumed at `SessionPage.tsx:509-519` | missing | Promotion ships a **drop-in adapter component** with the same props so `SessionPage.tsx` changes by one import under a feature flag. |
| Status bar (+ `hideStatusBar`) | `Terminal.tsx:880-916` | covered (shape differs) | PoC has its own status line; adapter must honor `hideStatusBar` and the parent-driven status display (`onStatusChange` → SessionPage header). |
| Loading-history indicator | `TerminalLoadingBar`, `Terminal.tsx:909-914, 930` | missing | Store exposes `loadingHistory`; trivial UI. |
| Truncation / restart notification banners | `Terminal.tsx:942-967` | missing | Same pattern as PoC's ExitBanner. |
| `MemoizedTerminal` memo rules | `Terminal.tsx:1003-1033` | structurally n.a. | The adapter re-renders cheaply; memo hacks for callback identity go away (store subscription isolates renders). |
| ErrorBoundary + remount keys (`resumeKey`) | `SessionPage.tsx:484-503` | covered | Remount is harmless by design now (instance survives). |

## Implementation priority

Per owner direction: **mobile first → daily-dogfood interactions → quality UX → advanced features**. Mobile is already the PoC's core; what remains on that axis is real-device hardening (iOS Safari IME quirks, Android keyboard variants) which rides along every phase's QA rather than being a separate PR.

## Staged PR plan

Five PRs. 1-3 build inside `labs/` only (existing `Terminal.tsx` / `worker-websocket.ts` / routes untouched — same discipline as the PoC). PR-4 performs the flag-gated swap. PR-5 deletes legacy after bake time.

### PR-1 — Store production-hardening (protocol completeness + memory management)

Scope (all inside `labs/terminal-poc/`). This PR is the implementation of **invariant 6**: restoration leans on the server's `worker-output-file` persistence + offset catch-up; the optional IndexedDB raw-stream mirror is added only if this PR's cold-start measurement justifies it.
- Reconnect: adopt `getReconnectDelay` / `shouldReconnect` from `lib/websocket-reconnect.ts`; raise attempt cap to production parity.
- Offset tracking: request `fromOffset=lastOffset` on reconnect; truncation-regression detection (reset + full resync); `output-truncated` handling.
- `worker-restarted` reset flow; `activity` passthrough; worker error surface (`{message, code}` incl. SESSION_DELETED / SESSION_PAUSED no-reconnect semantics).
- Output filters (`stripSystemMessages` / optional `stripScrollbackClear`) as store config.
- **Memory management** (design below): reference counting + idle eviction + hard cap.
- Perf verification: cold-start with a large history file (target: no worse than current cache-hit path; measure with `console.time` probe + document numbers in the PR).

Completion: store-level unit tests for every protocol flow above (MockWebSocket patterns exist); typecheck/test green; no UI change beyond banners' data being available.
Estimated diff: ~500-700 lines (store + tests). Regression risk: none outside labs (no shared file touched).

### PR-2 — Daily-dogfood interactions

Scope (labs only). Note: one item originally planned here — the mobile scroll indicator — was fast-tracked into the PoC ahead of this roadmap at owner request (see inventory row); PR-2 inherits only its polish follow-ups if dogfood surfaces any.
- **TUI focus parity (top priority in this PR — owner-reported gap)**: mouse reporting per the inventory row above. Tap/click on a TUI input field directs focus inside the TUI exactly as the existing terminal does (parity baseline: current `Terminal.tsx` behavior, owner-verified working). Includes wheel forwarding in alt-screen, and **mobile focus retention**: tapping inside the TUI must not dismiss the soft keyboard (the hidden textarea keeps DOM focus while the mouse report goes to the PTY), and soft-keyboard open/close must not drop focus.
- Native text selection + copy: verify/fix cross-row clipboard join, scope Cmd+A/Ctrl+A to terminal content, `user-select` boundaries around status bar / soft keys. Reference implementation: #935 D' (production xterm gets `macOptionClickForcesSelection` etc.; in the DOM renderer only the Cmd+A scoping and copy-text fidelity apply — document the mapping in the PR). Note the interplay with mouse reporting: when the app tracks the mouse, selection needs a modifier-key escape hatch (xterm uses Shift; adopt the same convention).
- Bracketed paste: honor DECSET 2004 (`\x1b[200~ ... \x1b[201~` wrapping when the app enabled it); regression-test the #792 asking-state scenario (multi-line paste while Claude Code shows a prompt).
- Image paste + drag-and-drop + overlay, emitting `onFilesReceived`-shaped events (adapter contract prepared but not yet wired to SessionPage).
- Clickable links.

Completion: unit tests for paste-mode wrapping + link detection; browser QA incl. mobile emulate for selection/copy; #792 scenario manually verified against real Claude Code.
Estimated diff: ~400-600 lines. Regression risk: none outside labs. Depends on PR-1 (store shape).

### PR-3 — Integration adapter (feature parity shell)

Scope (labs only):
- `PocTerminalAdapter` component implementing the exact `TerminalProps` contract (`sessionId`, `workerId`, `onStatusChange`, `onActivityChange`, `onRequestRestart`, `onResumeSession`, `onFilesReceived`, `hideStatusBar`, `stripScrollbackClear`).
- `WorkerErrorRecovery` wiring (reuse the existing component), session-delete mutation + navigation, `TerminalLoadingBar`, truncation/restart banners, status-bar parity.
- Side-by-side comparison page in labs (old vs new for the same worker) to make parity review concrete.

Completion: adapter unit tests (props → store wiring); browser QA walking the `WorkerErrorRecovery` paths (kill worker, pause session, delete session).
Estimated diff: ~400-500 lines. Depends on PR-1, PR-2.

### PR-4 — Flag-gated swap + fallback path

Scope (first PR that touches a shared file, and only one):
- A renderer feature flag (see Fallback below). `SessionPage.tsx` picks `MemoizedTerminal` or `PocTerminalAdapter` by flag. Default stays **legacy** on merge; the flag flips to **new** after the regression checklist passes in dogfood.
- Regression checklist executed and attached to the PR (see Verification plan).

Completion: both paths verified switchable at runtime; checklist attached; owner sign-off to flip the default is a separate, revertible one-line follow-up.
Estimated diff: ~50-100 lines production + checklist doc. Depends on PR-3. Regression risk: contained by the flag; emergency revert = flip default back (no deploy-blocking rollback).

### PR-5 — Legacy removal (separate sprint, after bake time)

Scope: delete `Terminal.tsx`, `terminal-state-cache.ts`, `terminal-state-save-manager.ts`, `terminal-chunk-writer.ts`, `render-diagnostics.ts`, `useTerminalWebSocket.ts` (if unreferenced), the flag, and the stall-workaround docs; move `labs/terminal-poc/` to `components/terminal/`; glossary + design-doc updates.
Trigger: owner declares bake period over (suggested: 2+ weeks of default-on dogfood without a P1 terminal issue).
Estimated diff: large negative (~-2000 lines). Depends on PR-4 + bake.

> **Execution note (2026-07-03, PR #962):** the deletion shipped as scoped above, but two PR-5 items were deliberately deferred to keep the removal a pure single-revert deletion: the `labs/terminal-poc/` → `components/terminal/` rename and the glossary/design-doc consolidation. Both are tracked in [#963](https://github.com/ms2sato/agent-console/issues/963). The bake period was cut short by owner decision after the evidence recorded in #940 (the intermediate default-flip was skipped for the same reason).
>
> **Update (#963):** the `labs/terminal-poc/` → `components/terminal/` move landed, and the `Poc` prefix was dropped from all identifiers (`PocTerminalAdapter` → `TerminalAdapter`, `poc-terminal-store` → `terminal-store`, etc.); the dev scratch route moved to `/labs/terminal`. `labs/terminal-poc/*` path references elsewhere in this document are retained as historical spec (line references were captured against the pre-move tree).

## Memory management design (PR-1)

The long-lived instance is the point — but "lives past unmount" must not mean "lives forever". Design:

- **Reference counting.** The adapter/view acquires on mount (`instance.acquire()` → refCount+1) and releases on unmount. This replaces nothing user-visible; it only feeds eviction.
- **Idle eviction.** When refCount drops to 0, start a TTL timer (default 15 min). Remount cancels it. On expiry: `dispose()` (close WS, dispose headless terminal, drop from registry). Rationale: 15 min covers tab-hopping and short breaks; a fresh history fetch after that is cheap (verified in PR-1 perf item).
- **Hard cap (LRU).** Registry capped (default 12 instances). On overflow, evict the least-recently-released refCount-0 instance immediately. Instances with refCount > 0 are never evicted.
- **Event-driven disposal.** Subscribe to app-WS session-deleted / worker-deleted events: dispose immediately (mirrors `worker-websocket.disconnectSession`, `worker-websocket.ts:664-679`). `exited` instances keep the shorter TTL (5 min) — the buffer is still useful for reading the tail, but there is no live process to protect.
- **Memory ceiling context.** Each instance holds one headless buffer (~cols x scrollback cells; a few MB at 5000 lines) + one WS. 12 instances is comfortably under what the old IndexedDB cache kept on disk per worker.

All numbers are constants at the top of the store, tuned during dogfood.

## Fallback path (PR-4)

- **Mechanism**: a client-side flag read at the `SessionPage` terminal mount site. Storage: `localStorage['terminal-renderer'] = 'legacy' | 'next'` with an in-app toggle in Settings (dev section). Default comes from a build-time constant so flipping the fleet default is a one-line PR.
- **Why localStorage over server config**: per-browser opt-in matches the dogfood pattern (owner can run 'next' on phone, 'legacy' on desktop simultaneously); no server contract change; zero migration.
- **Emergency revert**: flip the build-time default back to `legacy` (one-line revert, no data loss — the two paths share only the WS protocol, and state on the 'next' side is reconstructable from server history by design).
- **Non-goal**: running both renderers for the same worker at once in production UI (the comparison page in labs covers side-by-side needs; note both attach separate WS connections, which the server already supports).

## Regression verification plan (PR-4 checklist)

Feature-parity checklist, executed on desktop + mobile emulate + at least one real device before the default flips:

1. **Claude Code full session**: launch, prompt round trip, permission prompt (asking-state), truecolor/CJK/box-drawing, exit + restart via recovery UI.
2. **Paste matrix**: single-line text, multi-line text into asking-state (the #792 scenario), image paste, image drop (overlay), bracketed-paste on/off apps (`cat` vs Claude Code).
3. **Selection/copy matrix**: word, multi-row, full-screen Cmd+A (scoped), copy fidelity (no trailing-space garbage, newline joins).
4. **Lifecycle**: tab switch (instant restore), route away/back, browser reload (cold start timing), worker restart event, session pause → recovery UI, session delete → navigation, server restart mid-session (truncation resync).
5. **Reconnect**: kill dev server 30s, restart — backoff visible, offset-delta resync (no duplicate output), exited terminal does NOT reconnect.
6. **Mobile**: soft keyboard open/close layout, touch momentum scroll, jump-to-bottom, IME (Japanese) composition + confirm, soft key bar.
7. **Longevity**: 1h+ Claude Code session at scrollback cap (row-cache disabled path), memory profile flat, 12+ worker tabs (eviction observable, no dead terminals in UI).

**Known fragile points** (watch explicitly during bake; sources: sprint lessons + PoC review rounds):
- Bracketed paste x asking-state (#792/#793: the diagnosis history shows this breaks subtly and E2E through the real UI is mandatory).
- IME on iOS Safari (composition events differ from desktop; PoC preview logic is desktop-verified only).
- Scrollback-cap behavior (row cache disabled at cap — perf on low-end mobile).
- `stripSystemMessages` regex filters straddling chunk boundaries (a `[internal:*]` line split across two `output` messages passes the filter; pre-existing gap in production too — do not regress it further; candidate follow-up).
- React Strict Mode double-mount vs refcount (acquire/release must be idempotent per mount instance).
- Mouse reporting x native text selection: when a TUI enables mouse tracking, pointer events go to the app and browser selection must be reachable via a modifier (Shift, matching xterm's convention). Getting both UX paths right on touch (long-press select vs tap-to-focus) is the hardest interaction problem in PR-2 — prototype early.

## Future direction (outside this roadmap, owner-endorsed observation)

Dogfood of the fast-tracked alt-screen scroll forwarding (2026-07-02) confirmed an inherent ceiling: TUI scrolling through a terminal is line-granular and paced by the app-redraw round trip — correct (identical to native terminals in mechanism) but never as smooth as native browser scrolling, and synthetic momentum would only cosmetically mask it. The owner's direction: accept the current forwarding as the honest terminal-emulator baseline for this roadmap, and treat **data-level transcript integration** (rendering Claude Code's conversation from its transcript data as native web UI, instead of scraping the drawn screen) as the real answer for smooth conversation-history scrolling. That is an agent-console product capability unlocked by the renderer swap, to be designed in its own future track — not a promotion-phase item.

Related external work: [#945](https://github.com/ms2sato/agent-console/issues/945) tracks an xterm.js upstream patch proposal for the selection-vs-mouse-tracking failure paths documented in [#943](https://github.com/ms2sato/agent-console/issues/943). This renderer's native-selection layer satisfies those requirements (R1/R2) structurally, which both removes the need for the patch here and serves as the working counter-example strengthening the upstream proposal.

## What deliberately does not carry over

For reviewers checking "did we forget X": `SerializeAddon` and the entire cache family (invariant 2), `FitAddon` (ResizeObserver + measurement replaced it), `WebLinksAddon` (DOM-native links), render-stall watchdog and `_isPaused` recovery (nothing to force), `distanceFromBottom` scroll recovery (native scroll), `MemoizedTerminal` comparator (store subscription isolates renders), chunked writer backpressure (off-DOM writes), mount-generation guards and AbortController cache races (no async cache), deferred dispose (no owned resource). Also deferred by review agreement on #934: input buffering while disconnected and a distinct "reconnect exhausted" status (both match current production behavior; revisit post-swap as product decisions).

## Issue map

| Phase | Issue | Depends on |
|---|---|---|
| PR-1 | [#937](https://github.com/ms2sato/agent-console/issues/937) Store production-hardening + memory management | — |
| PR-2 | [#938](https://github.com/ms2sato/agent-console/issues/938) TUI focus parity, selection/copy, paste, links | #937 |
| PR-3 | [#939](https://github.com/ms2sato/agent-console/issues/939) TerminalProps adapter + recovery/banner parity | #937, #938 |
| PR-4 | [#940](https://github.com/ms2sato/agent-console/issues/940) Feature-flag swap + regression checklist | #939 |
| PR-5 | [#941](https://github.com/ms2sato/agent-console/issues/941) Legacy removal after bake | #940 + bake period |
