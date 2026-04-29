# wterm Adoption Evaluation

Research date: 2026-04-29
Branch: `research/wterm-evaluation`
Author: Orchestrator-delegated research agent
Scope: read-only; no production code modified.

## Executive summary

`vercel-labs/wterm` is an early-stage (v0.2.0, first commit 2026-04-14) browser terminal emulator that compiles a Zig-based VT parser to a 13 KB WASM binary and ships a small DOM/React/Vue rendering layer on top. The bundle footprint is dramatically smaller than xterm.js + addons, and the React API integrates cleanly with our existing Vite/React 18 client. The wire protocol is deliberately *unopinionated* — the published `WebSocketTransport` is one optional helper, and the actual examples wire `ws.onmessage` directly into `WTerm.write(string)`. That gives us full freedom to keep our existing `/ws/session/:sessionId/worker/:workerId` framing and our `request-history` / `output-truncated` / `activity` / `exit` server-message vocabulary unchanged.

**However**, four concrete gaps make wterm a non-starter for whole-replacement of xterm.js in agent-console *as of 2026-04-29*:

1. **No CJK / wide-character cell support.** Open issue [#54](https://github.com/vercel-labs/wterm/issues/54) (filed 2026-04-27) documents that `Terminal.printChar` advances the cursor by exactly one column for every codepoint, including East-Asian-Width Wide / Fullwidth and emoji. Every cursor-positioned redraw drifts after the first wide character. Claude Code and the agent CLIs we host emit emoji, box-drawing, and Japanese characters routinely.
2. **No `serialize`/headless-snapshot equivalent.** Open issue [#35](https://github.com/vercel-labs/wterm/issues/35) is a feature request from a project with the same shape as ours (daemon backend with terminal-resume). We currently rely on `@xterm/addon-serialize` in `packages/client/src/components/Terminal.tsx:5,428` and `lib/terminal-state-cache.ts` for the IndexedDB cache that eliminates flicker on tab switching. There is no public wterm API to capture grid + scrollback + SGR state into a string.
3. **Hard 256×256 grid clamp.** Open issue [#56](https://github.com/vercel-labs/wterm/issues/56) — `MAX_COLS = 256` / `MAX_ROWS = 256` are baked into the Zig grid, and the WASM `resize` silently clamps without signaling the embedder. Ultrawide-monitor users (>256 cols) would see the host PTY and the in-browser grid disagree, producing the same drift class as #54.
4. **Missing TUI features that our hosted agents use.** Synchronized output mode ([#57](https://github.com/vercel-labs/wterm/issues/57)), mouse/focus tracking ([#55](https://github.com/vercel-labs/wterm/issues/55)), and box-drawing geometry ([#52](https://github.com/vercel-labs/wterm/issues/52), [#49](https://github.com/vercel-labs/wterm/issues/49)) are silently ignored or mis-rendered. tmux, lazygit, neovim, btop produce visible artifacts.

The recommendation at the bottom (§6) is **(a) stay on xterm.js**, with a re-evaluation after #54 / #35 / #56 close. Adopting wterm now would be an active regression for our primary use case (hosting Claude Code in worktrees).

The remainder of this document is the evidence behind that recommendation.

---

## 1. Transport protocol mapping

### 1.1 What wterm ships

wterm separates *transport* from *terminal*. The terminal layer (`@wterm/dom` `WTerm`, `@wterm/react` `<Terminal />`) takes:
- an `onData(string)` callback for keystrokes and PTY responses (DSR replies, bracketed-paste sequences, etc.); and
- a `write(string | Uint8Array)` imperative method for incoming PTY output.

The transport layer (`@wterm/core` `WebSocketTransport`) is an *optional* convenience class. Both example servers (`examples/local/server.ts`, `examples/ssh/server.ts`) and our own integration would wire `ws.onmessage → terminal.write` and `terminal.onData → ws.send` directly without touching `WebSocketTransport`. Nothing in `@wterm/dom` knows about WebSockets.

### 1.2 `WebSocketTransport` (the helper) — full surface area

Source: [`packages/@wterm/core/src/transport.ts`](https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/core/src/transport.ts).

| Aspect | wterm `WebSocketTransport` | agent-console worker WS |
|---|---|---|
| Framing | None. Raw `MessageEvent.data` either `ArrayBuffer` (binary) or `string` (text). String sends are TextEncoder-encoded to bytes before send. | JSON-encoded `WorkerClientMessage` / `WorkerServerMessage`. See `packages/shared/src/types/session.ts:91-131`. |
| Resize | Inline ANSI escape `\x1b[RESIZE:cols;rows]` parsed server-side in `examples/local/server.ts`. Not a transport feature — purely an example convention. | Discrete typed message `{ type: 'resize', cols, rows }`, validated in `packages/server/src/websocket/worker-handler.ts:44-52` (1–1000 bound). |
| Other control sequences | None defined by the transport. The example uses *only* the `RESIZE` inline escape; everything else is raw stdin/stdout. | `request-history { fromOffset? }`, `input { data }`, plus server-side `output / exit / history / activity / error / output-truncated / server-restarted`. See `docs/design/websocket-protocol.md`. |
| Reconnection | Built in. Exponential backoff `1000 ms × 2^n`, capped at `maxReconnectDelay` (default 30 s). No jitter. Buffers `send()` calls during disconnect, flushes on reopen. | Exponential backoff 1 s → 30 s with ±30% jitter (per `docs/design/websocket-protocol.md` "Reconnection Strategy"). |
| Backpressure | None. Outbound buffer is an in-memory `(string \| Uint8Array)[]` array drained on `_flushBuffer()`. No high-water-mark / drop policy. | `BufferedWsSender` in `packages/server/src/websocket/buffered-ws-sender.ts` provides server→client buffering for slow clients. Client→server is unbuffered (typing rate). |
| Heartbeat | None. Relies on transport-level `close` events. | None at the WebSocket layer; offset-based history (`output { offset }` + `request-history { fromOffset }`) provides resync after reconnect. |
| Binary support | `binaryType = "arraybuffer"`. Both directions. | Currently text-only JSON (server validates string vs ArrayBuffer in `worker-handler.ts:78`). |
| Connection lifecycle hooks | `onOpen / onClose / onError / onData` callbacks. | Hono `app.get('/ws/...', upgradeWebSocket(...))` + `BufferedWsSender` lifecycle. |

### 1.3 Diff if we *replaced* the transport with `WebSocketTransport`

Not recommended. We would lose:
- Typed `WorkerServerMessage` / `WorkerClientMessage` discrimination — the transport is opaque bytes, so we'd have to layer JSON ourselves anyway.
- `request-history` / `output-truncated` / `activity` / `error` semantics — these aren't in wterm's vocabulary; we'd still implement them on top.
- Server-side `validateWorkerMessage` width clamping (1–1000) and the `resize` exhaustive switch.
- ±30% jitter in reconnect (the wterm transport has plain x2 backoff with no randomization).

### 1.4 Diff if we *kept* the existing transport and only swapped the renderer

This is the only realistic integration shape. Required client-side changes:
- Replace `terminal.onData(data => sendInput(data))` with `<Terminal onData={data => sendInput(data)} />` (`Terminal.tsx:636-638`).
- Replace `terminal.write(processOutput(data), cb)` with `wtermRef.current?.write(processOutput(data))` (no callback signature; render is RAF-scheduled inside `WTerm._scheduleRender`). See `Terminal.tsx:223,261` for current call sites and `wterm.ts:138-148` for the RAF write path.
- Replace `terminal.onScroll` and the `_renderDebouncer`-hooked render-stall watchdog (`Terminal.tsx:443-523`) — wterm has no equivalent introspection points.

There are ~50 call sites in `Terminal.tsx` that depend on xterm.js shape (`buffer.active.viewportY`, `attachCustomKeyEventHandler`, `loadAddon`, etc.). The full migration LoC is substantial — see §3.

---

## 2. xterm.js feature comparison

| Capability | xterm.js (current) | wterm (v0.2.0) | Verdict |
|---|---|---|---|
| **Bundle size** | ~290 KB (`@xterm/xterm`) + addons (~20 KB total) | 13 KB WASM (base64-inlined into JS) + ~40 KB JS for `@wterm/dom` + `@wterm/react`. WASM sub-path export `@wterm/core/wasm` available as separate fetch | wterm clearly wins (~5× smaller) |
| **Renderer** | DOM, canvas, or WebGL (multiple backends) | DOM only — `term-grid` div containing `term-row` divs containing `<span>` runs. Each cell is a span. Block-glyph backgrounds via CSS gradients. | xterm.js richer; wterm relies on browser CSS for blocks |
| **Wide / CJK / emoji** | Full EAW handling, ligature support via addon | **Not implemented** — issue [#54](https://github.com/vercel-labs/wterm/issues/54), every codepoint advances cursor by 1. Confirmed in `src/cell.zig` (no width field) | xterm.js. Critical for our use case |
| **Box-drawing characters** | Native fixed-width via Unicode/font | Not fixed-width — issue [#52](https://github.com/vercel-labs/wterm/issues/52). tmux status bar shows `qqqqq` placeholder ([#49](https://github.com/vercel-labs/wterm/issues/49)) | xterm.js |
| **Mouse / focus tracking** | DEC modes 1000/1002/1003/1004/1006/1015 | **Not implemented** — issue [#55](https://github.com/vercel-labs/wterm/issues/55) | xterm.js |
| **Synchronized output (BSU/ESU, DEC ?2026)** | Supported | **Not implemented** — issue [#57](https://github.com/vercel-labs/wterm/issues/57). Causes mid-frame partial paint on neovim/lazygit | xterm.js |
| **Bracketed paste** | Supported | Supported, with security hardening (ESC stripping in `input.ts`, fixed in v0.1.9 [#33](https://github.com/vercel-labs/wterm/pull/33)) | Tie |
| **IME / composition (Japanese, etc.)** | Supported via `attachCustomKeyEventHandler` + `event.isComposing` (used in `Terminal.tsx:642-644`) | Supported via hidden `<textarea>` with `compositionstart` / `compositionend` listeners (`input.ts:138,193-198`) | Tie. wterm uses cleaner textarea-as-input pattern |
| **Scrollback** | Configurable size, full cell history | Built-in (`getScrollbackCount`, `getScrollbackLine` in `wasm-bridge.ts`); shrink corrupts ([#43](https://github.com/vercel-labs/wterm/issues/43)) | xterm.js |
| **Find / search** | `@xterm/addon-search` | Native browser text selection (DOM-rendered) — `Cmd+F` works on the terminal text. No incremental search | xterm.js for programmatic search; wterm wins for "select & copy with the mouse" UX |
| **Web links / clickable URLs** | `@xterm/addon-web-links` (we use it at `Terminal.tsx:4,422`) | Not in `@wterm/dom`. Could be added as DOM linkification but no built-in addon | xterm.js |
| **Serialize (state snapshot)** | `@xterm/addon-serialize` (we use it at `Terminal.tsx:5,428` and `terminal-state-cache.ts`) | **Not implemented** — issue [#35](https://github.com/vercel-labs/wterm/issues/35) is an open feature request from a same-shape project. Closing this would also need a deserialize/replay path for our IndexedDB resume | xterm.js. **Critical for our IndexedDB cache** |
| **Image protocols (Sixel, Kitty, iTerm2)** | Supported via `@xterm/addon-image` | Not implemented | xterm.js |
| **Accessibility** | Screen-reader mode (off by default) | `role="textbox"` + `aria-multiline` + `aria-roledescription` set on container in `Terminal.tsx`. Hidden textarea is `aria-hidden="true"` | Roughly comparable for basic SR; xterm.js has more configuration |
| **Mobile soft keyboard** | Workable but quirky | iOS Safari issues open ([#41](https://github.com/vercel-labs/wterm/issues/41), [#32](https://github.com/vercel-labs/wterm/issues/32)) — soft keyboard repeat broken, textarea positioning breaks paste | xterm.js |
| **Render stall recovery** | Required workaround in `Terminal.tsx:442-523` (we hook `_renderDebouncer`) | RAF-scheduled, no `_isPaused` equivalent. Whether wterm has its own stall pathology is unknown — no field reports yet | Unknown — wterm is too young |
| **API stability** | 5.x is stable, large established surface | 0.2.0; AGENTS.md release process is "manual, single-PR affairs" by one maintainer (`@ctate` per CHANGELOG) | xterm.js |
| **License** | MIT | Apache-2.0 | Both permissive |

---

## 3. Integration feasibility (implementation lens)

### 3.1 Current xterm.js usage in agent-console

Files that import `@xterm/*`:
- `packages/client/src/components/Terminal.tsx` — 1033 LoC. Imports `Terminal as XTerm`, `FitAddon`, `WebLinksAddon`, `SerializeAddon`, plus `@xterm/xterm/css/xterm.css`. Uses: `terminal.open()`, `loadAddon()`, `onData`, `attachCustomKeyEventHandler`, `onScroll`, `write(data, callback)`, `refresh()`, `cols`, `rows`, `buffer.active.{viewportY,baseY,length}`, `scrollLines()`, `scrollToBottom()`, `serialize()` (via addon), `fit()` (via addon). Hooks `_core._renderService._renderDebouncer.refresh` for stall recovery.
- `packages/client/src/lib/terminal-chunk-writer.ts` — chunked write buffering for large history payloads.
- `packages/client/src/lib/terminal-utils.ts` — `isScrolledToBottom(terminal)`, `stripScrollbackClear`, `stripSystemMessages`. `isScrolledToBottom` reads `buffer.active.{viewportY,baseY}` and `rows`.
- `packages/client/src/lib/terminal-state-cache.ts` — IndexedDB cache layer that depends on `serializeAddon.serialize()` returning a string and `terminal.write()` accepting that string back.
- `packages/client/src/components/__tests__/Terminal.test.tsx`, `packages/integration/src/paste-focus-isolation.test.tsx` — test files.
- `packages/client/src/vite-env.d.ts`, `package.json`, `packages/server/src/services/{env-filter,user-mode}.ts` — non-rendering references (xterm-256color env var, etc.).

### 3.2 Surface-area mapping (xterm.js → wterm)

| xterm.js API used | wterm equivalent | Migration delta |
|---|---|---|
| `new XTerm({...})` | `new WTerm(el, {...})` (or React `<Terminal />`) | Different constructor signature; element passed in |
| `terminal.open(container)` | Constructor takes element | One fewer step |
| `terminal.loadAddon(...)` | None — features are built in or absent | Drop `FitAddon` (use `autoResize: true` + ResizeObserver, but with the 256 clamp). Drop `WebLinksAddon` (no replacement). Drop `SerializeAddon` (no replacement → blocks IndexedDB cache) |
| `terminal.write(data, callback)` | `wt.write(data)` (no callback; render is RAF-batched) | Lose write-completion callback used by `terminal-chunk-writer.ts` and the watchdog (`Terminal.tsx:223,261`) |
| `terminal.onData(cb)` | `wt.onData = cb` (settable property) or constructor option | Mostly mechanical |
| `terminal.attachCustomKeyEventHandler(handler)` | No equivalent — must intercept at the container's `keydown` capture phase before wterm's hidden textarea sees it | Need to re-implement Shift+Enter handling (`Terminal.tsx:641-657`) outside the wterm input layer |
| `terminal.onScroll(cb)` | No equivalent — would have to listen to container `scroll` events | Refactor `updateScrollButtonVisibility` (`Terminal.tsx:744-746`) |
| `terminal.refresh(0, rows-1)` | No equivalent (RAF-batched internally) | Drop the render-stall recovery (no introspection points to detect a stall) |
| `terminal.buffer.active.{viewportY,baseY,length}` | No public buffer API | `isScrolledToBottom` (in `terminal-utils.ts`) needs a fully different implementation against the container's scrollTop/scrollHeight. Scroll-position restoration logic in `restoreScrollPosition` (`Terminal.tsx:74-87`) cannot port directly |
| `serializeAddon.serialize()` + `terminal.write(serialized)` | None | **Blocks the IndexedDB cache feature entirely until issue [#35](https://github.com/vercel-labs/wterm/issues/35) closes** |

Estimated migration cost (rough LoC, just `Terminal.tsx`): ~600 LoC rewrites or removals. Plus the addon-replacement features (web-links, serialize) that *cannot* be done without losing capability.

### 3.3 Vite + WASM bundling

wterm's `@wterm/core` runs `scripts/inline-wasm.js` at `prebuild` time and emits `wasm-inline.js` containing `WASM_BASE64`. The WASM file is 13 KB → ~17 KB base64. `WasmBridge.load(url?)` defaults to `decodeBase64(WASM_BASE64)`; only used as a separate fetch when `wasmUrl` is supplied. So Vite consumers don't need `vite-plugin-wasm`, and there is no `assetInlineLimit` interaction. The published JS bundle is self-contained.

This is genuinely simpler than e.g. `@webcontainer/api`'s WASM handling.

### 3.4 React 18 vs 19

`@wterm/react` peer-deps `^18.0.0 || ^19.0.0`. `Terminal.tsx` uses React 19 callback-ref-with-cleanup syntax (`return () => { ... }` from `useCallback` ref). On React 18 this works but the cleanup runs on unmount, not on element change. Our `Terminal.tsx` already uses similar patterns; should be a non-issue.

---

## 4. Bun server implementation feasibility

### 4.1 No work needed on the server side

This is the cleanest part of the analysis. wterm's transport choice is *not the server's concern*. We already serve raw byte streams from `bun-pty` over our existing `/ws/session/:sessionId/worker/:workerId` WebSocket. The wterm React component receives strings via `wt.write(string)`; whatever JSON envelope we use to deliver those bytes is invisible to wterm.

If we adopted wterm only as the renderer (the realistic shape), the server stays exactly as it is. `bun-pty` continues to provide PTY semantics (`packages/server/src/lib/pty-provider.ts:1`); the inline-RESIZE-escape pattern from wterm's example is *not* used because we already have a typed `{ type: 'resize', cols, rows }` message handled by `worker-handler.ts:44-52`.

### 4.2 If we hypothetically wanted wterm's transport spec on the server

Sketch of an alternative server that mirrors `examples/local/server.ts` against Bun + bun-pty:

```typescript
// Pseudocode — for illustration only, NOT proposed for adoption.
// Hono + native Bun WebSocket; bun-pty for PTY.
import { ptyProvider } from './lib/pty-provider';

app.get('/ws/wterm/:workerId',
  upgradeWebSocket((c) => {
    let pty: PtyInstance | null = null;
    return {
      onOpen(_evt, ws) {
        pty = ptyProvider.spawn('/bin/zsh', ['-l'], { cols: 80, rows: 24, cwd: HOME, env });
        pty.onData(d => ws.send(d));               // raw bytes, no JSON envelope
        pty.onExit(() => ws.close());
      },
      onMessage(evt, _ws) {
        const msg = typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data);
        const m = msg.match(/^\x1b\[RESIZE:(\d+);(\d+)\]$/);
        if (m) { pty?.resize(+m[1], +m[2]); return; }
        pty?.write(msg);
      },
      onClose() { pty?.kill(); pty = null; },
    };
  })
);
```

This works on Bun (no `node-pty` dependency — we use `bun-pty` which is pure-Rust under the hood, see `packages/server/src/lib/pty-provider.ts:36`). Concerns about wterm + `node-pty` on Bun specifically (web search above flagged native C++ addons as one of Bun's compatibility weak spots) are not load-bearing for us, because we already use `bun-pty` and have a `PtyProvider` abstraction with a documented future `Bun.Terminal` migration path (`pty-provider.ts:43-56`).

The reason **not** to do this is the same reason §1.3 said don't replace the transport: we'd lose `request-history`, offset-based incremental sync, `activity`/`exit`/`output-truncated` semantics, plus the server-side `validateWorkerMessage` width clamping. Those are agent-console differentiators worth keeping.

### 4.3 Inline-RESIZE escape hazard

wterm's `WTerm.onData` callback is invoked for *all* outbound data — keystrokes *and* DSR/CPR responses synthesized by the WASM core (cursor-position queries from the host program, etc.). If we adopted the example's `\x1b[RESIZE:cols;rows]` convention, a sufficiently devious DSR response *could* be misparsed as a resize request. Our existing typed `{type:'resize'}` message avoids this entirely. Yet another reason to keep the existing transport.

---

## 5. Risks and unknowns

### 5.1 Open issues that block adoption (in severity order)

1. **[#54 Wide chars / CJK / emoji not handled](https://github.com/vercel-labs/wterm/issues/54)** — filed 2026-04-27, no fix yet. Source-level fix requires a `width` field on `Cell` in `src/cell.zig` plus continuation-cell tracking. Medium-large change in the Zig core. Until fixed, every Claude Code panel that includes emoji or Japanese characters will visibly desync.
2. **[#35 Headless / serialize equivalent](https://github.com/vercel-labs/wterm/issues/35)** — open feature request; agent-console-shaped use case; no ETA.
3. **[#56 256×256 grid clamp](https://github.com/vercel-labs/wterm/issues/56)** — silent clamp; affects ultrawide users. Fix requires either dynamically allocating the grid (large refactor) or at minimum signaling clamping back to the embedder (smaller fix).
4. **[#57 Synchronized output mode silently ignored](https://github.com/vercel-labs/wterm/issues/57)** — affects neovim, lazygit (mid-frame partial paint).
5. **[#43 Scrollback corrupts on shrink](https://github.com/vercel-labs/wterm/issues/43)** — affects every resize-down operation.
6. **[#55 Mouse / focus tracking missing](https://github.com/vercel-labs/wterm/issues/55)** — tmux mouse, btop click navigation broken.
7. **[#52 / #49 Box-drawing geometry](https://github.com/vercel-labs/wterm/issues/52)** — tmux/btop visible artifacts.
8. **[#41 / #32 iOS Safari mobile keyboard issues](https://github.com/vercel-labs/wterm/issues/41)** — relevant if mobile is a target.

### 5.2 Maintenance / project-health signals

- Repository created 2026-04-14; v0.2.0 released 2026-04-26 (12 days later). Active.
- 2,579 stars, 102 forks, 17 open issues, 0 closed-as-fixed issues yet (only 1 closed: [#31](https://github.com/vercel-labs/wterm/issues/31)). No CONTRIBUTING.md ([#53 is the issue tracking that](https://github.com/vercel-labs/wterm/issues/53)).
- CHANGELOG and `AGENTS.md` show one primary maintainer (`@ctate`). Vue port (#30) added by `@posva`. Trusted-publisher CI added.
- Vercel Labs org has 262 repos, 7 archived (~2.7%). Vercel Labs is an experimental sandbox; repos there have no LTS commitment by Vercel. The Apache-2.0 license means a fork is always possible.
- AGENTS.md states: "Releases are manual, single-PR affairs. The maintainer controls the changelog voice and format." This is healthy for a v0.x project but signals bus-factor risk.

### 5.3 Production usage signals

- Web search returned no third-party "we ship wterm in production" reports as of 2026-04-29. Stars (2,579) reflect interest, not deployment.
- Two downstream projects are referenced by issue #54: [`njbrake/agent-of-empires`](https://github.com/njbrake) (issues #830, #831). These are *bug reports against wterm filed during use of those projects*, not endorsements. Both reports are essentially "Claude Code / Cursor-agent renders garbled in our wterm-hosted view".
- DeepWiki and `upd.dev` listings are tracker pages, not user testimonials.

### 5.4 Stability claim grounding

The version label "0.2.0" itself is the most honest signal: SemVer 0.x explicitly disclaims stability, and the CHANGELOG between 0.1.5 → 0.2.0 (~3 weeks) shows multiple bug fixes per release in core input handling (Shift, Cmd+A, Ctrl+U, focus scroll, height calculation). This is normal for a young project, but it is *not* "stable".

### 5.5 Unverified items

- **wterm render-stall behavior under sustained high-throughput PTY output.** Our xterm.js setup needed a 60-LoC watchdog (`Terminal.tsx:443-523`); whether wterm has equivalent issues at e.g. 100 KB/s burst rates is unknown — no field reports, our research did not benchmark.
- **wterm memory growth under long-lived sessions with large scrollback.** Not benchmarked.
- **Whether `WasmBridge.writeRaw` chunking (8192 bytes per call into WASM) holds up under multi-MB history replays.** Not benchmarked. The current `terminal-chunk-writer.ts` design assumes xterm.js back-pressure semantics (the `callback` argument to `terminal.write`), which wterm does not provide.
- **xterm.js bundle-size advantage of wterm at the *transit-encoded* level (gzip/brotli).** I cited raw bytes; gzipped numbers may differ.
- **iOS Safari severity for our user base.** We do not have data on whether anyone uses agent-console on a phone.

---

## 6. Alternatives comparison

| Option | Effort | Risk | Capability delta vs today |
|---|---|---|---|
| **(a) Stay on xterm.js** | 0 | Low. Mature library, known stall workaround in place | Baseline |
| **(b) Full replacement with wterm** | High (~600 LoC rewrite in `Terminal.tsx`, plus removal of cache feature, plus new mouse/focus shims, plus accepting CJK breakage) | **Very high** — issues #54, #35, #56, #57 are all live regressions on day one for our primary use case (Claude Code, agent CLIs with emoji/Japanese/box-drawing) | Loses: serialize-based IndexedDB cache, web-links, full EAW, mouse tracking, sync-output, box-drawing geometry. Gains: 5× smaller bundle, simpler init, native browser text selection |
| **(c) Partial / coexistence (e.g., new feature uses wterm)** | Medium — would require a second renderer abstraction, two code paths in Terminal.tsx or a sibling component | Medium — fragments the rendering layer, multiplies stall pathologies, and the same core bugs (CJK, serialize) still apply to whichever surfaces use wterm | Limited upside; wherever we point an agent CLI, the wterm surface still mis-renders |

### Recommendation

**(a) Stay on xterm.js.** Re-evaluate when:
1. Issue [#54](https://github.com/vercel-labs/wterm/issues/54) closes (CJK / emoji width handling), AND
2. Issue [#35](https://github.com/vercel-labs/wterm/issues/35) closes with a publicly-documented serialize/restore API, AND
3. Issue [#56](https://github.com/vercel-labs/wterm/issues/56) is at minimum signaling clamping back to embedders.

Without all three, adoption is a regression. With all three, it becomes worth re-running a focused integration spike (likely a 1-day proof-of-concept against a subset of `Terminal.tsx` features).

---

## Appendix A: References

- wterm repository: <https://github.com/vercel-labs/wterm>
- wterm v0.2.0 release: <https://github.com/vercel-labs/wterm/releases/tag/v0.2.0>
- wterm CHANGELOG: <https://github.com/vercel-labs/wterm/blob/main/CHANGELOG.md>
- wterm AGENTS.md: <https://github.com/vercel-labs/wterm/blob/main/AGENTS.md>
- wterm transport source: <https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/core/src/transport.ts>
- wterm WASM bridge source: <https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/core/src/wasm-bridge.ts>
- wterm DOM orchestrator: <https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/dom/src/wterm.ts>
- wterm React component: <https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/react/src/Terminal.tsx>
- wterm input handler: <https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/dom/src/input.ts>
- wterm renderer: <https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/dom/src/renderer.ts>
- wterm local example server: <https://github.com/vercel-labs/wterm/blob/main/examples/local/server.ts>
- wterm SSH example server: <https://github.com/vercel-labs/wterm/blob/main/examples/ssh/server.ts>
- xterm.js: <https://github.com/xtermjs/xterm.js>
- agent-console current Terminal: `packages/client/src/components/Terminal.tsx`
- agent-console current PTY provider: `packages/server/src/lib/pty-provider.ts`
- agent-console websocket protocol: `docs/design/websocket-protocol.md`
