# Terminal Render Stall Issue

**Date:** 2026-03-21
**Branch:** debug/terminal-render-stall-diagnostics
**PR:** #360
**Status:** Root cause narrowed down, fix pending

## Summary

Terminal display stops updating mid-session while the agent continues working. Data reaches the client and xterm.js's internal buffer is updated, but the DOM is not rendered. Resizing the browser window restores the display.

## Problem Description

- Agent (Claude Code) is actively producing output
- Terminal display stops updating at some point (appears frozen)
- Status bar shows "Connected" (WebSocket is alive)
- Resizing the browser window immediately restores the display
- No specific trigger identified (not related to tab switching)

## Investigation Timeline

### Phase 1: Initial Hypothesis - WebSocket Disconnection

Initially suspected a "half-open" WebSocket connection (silent TCP death). However, the user reported:

> "ブラウザのサイズを変えると続きが取れたりします" (Resizing the browser window can restore the continuation)

This ruled out WebSocket disconnection — if the connection were dead, resizing wouldn't help. Data must be reaching the client.

### Phase 2: Diagnostic Logging (PR #360)

Added opt-in diagnostic logging (`localStorage.setItem('terminal-render-diagnostics', 'true')`) to track:
- WebSocket message receipt
- `terminal.write()` calls and callbacks
- Stall detection (pending writes without callbacks)

**Result:** `STALL DETECTED` never fired. This confirmed that `terminal.write()` callbacks ARE completing — xterm.js's internal write processing (parsing) works correctly.

**Conclusion:** The issue is not in the data delivery or write processing pipeline. It's in the rendering pipeline AFTER write processing completes.

### Phase 3: Runtime Debugging via Chrome DevTools MCP

Injected debugging code directly into the running page via `evaluate_script` (no file modifications needed).

#### Step 1: Access xterm.js internals

Found the Terminal instance via React fiber tree traversal:
```javascript
// Walk up from .xterm container's parent via __reactFiber
// Find useRef hook with .write function and .cols/.rows properties
window.__xtermTerminal = val;
```

#### Step 2: Monitor DOM vs Buffer

Compared the last 3 rows of `.xterm-rows` DOM content with `terminal.buffer.active.getLine()`:

```
domMatchesBuffer: false
```

**DOM was NOT reflecting the buffer content** — confirmed the render stall.

#### Step 3: Inspect xterm.js RenderService

Examined `terminal._core._renderService._renderDebouncer`:

```json
{
  "_animationFrame": "undefined",   // <-- NO pending rAF!
  "_rowStart": "undefined",
  "_rowEnd": "undefined"
}
```

**Key finding:** The render debouncer had NO scheduled `requestAnimationFrame`. Without a pending rAF, the renderer never fires, so the DOM never updates.

Additional observations:
- `_renderService._isPaused: false` — Renderer is not explicitly paused
- `_renderService._needsFullRefresh: false` — No pending full refresh
- `document.visibilityState: "visible"` — Page is visible
- `document.hasFocus(): true` — Page has focus
- rAF loop (separate test) fires normally at ~2ms intervals

#### Step 4: Confirm recovery mechanism

Manually called `debouncer.refresh(0, terminal.rows - 1)`:

```json
{
  "before": { "animationFrame": undefined },
  "after": { "animationFrame": 94760, "rowStart": 0, "rowEnd": 37 },
  "triggered": true
}
```

**Display immediately recovered.** Screenshot confirmed the latest content appeared.

Note: `terminal.refresh(0, rows - 1)` did NOT work. Only `debouncer.refresh()` (which schedules a rAF) fixed it.

#### Step 5: Monitor `debouncer.refresh()` calls

Hooked `debouncer.refresh()` to track when it's called:

```javascript
const origRefresh = debouncer.refresh.bind(debouncer);
debouncer.refresh = function(rowStart, rowEnd) {
  state.refreshCallCount++;
  // ...
  return origRefresh(rowStart, rowEnd);
};
```

**During normal operation:** write:refresh ratio is exactly 1.000 (every write triggers a refresh).

**During stall:** `debouncer.refresh()` stops being called even though `terminal.write()` continues and callbacks complete.

## Root Cause Analysis

### What we know for certain

1. **Data reaches the client** — WebSocket is alive, `terminal.write()` is called
2. **Write processing completes** — Callbacks fire, buffer is updated correctly
3. **Render debouncer stops scheduling rAF** — `_animationFrame` becomes `undefined`
4. **`debouncer.refresh()` stops being called** — The event chain from buffer update to render scheduling breaks
5. **Manual `debouncer.refresh()` restores rendering** — The renderer itself is functional
6. **`terminal.resize()` restores rendering** — Because resize internally calls `debouncer.refresh()`

### What we don't know yet

- **Why does `debouncer.refresh()` stop being called?**
  - Possible: An event listener in xterm.js's internal chain gets disconnected
  - Possible: A condition flag prevents the render service from forwarding buffer change events
  - Possible: The `_renderService._isNextRenderRedrawOnly` flag or similar causes events to be skipped

### xterm.js render pipeline (normal flow)

```
terminal.write(data)
  → WriteBuffer processes data
  → Parser updates Buffer
  → Buffer emits change events
  → RenderService receives events
  → RenderService calls _renderDebouncer.refresh(rowStart, rowEnd)
  → RenderDebouncer schedules requestAnimationFrame
  → rAF fires → DOM updated
```

**The break occurs between "Buffer emits change events" and "_renderDebouncer.refresh()".**

## Verification on User's Browser

Used the NO_REFRESH stall detector script (v4) which hooks `terminal.write()` and `debouncer.refresh()` to detect when writes happen without corresponding refresh calls. Auto-recovers via `debouncer.refresh()`.

### Stall log data (4 stalls captured in ~15 minutes)

| # | Time | Interval | newW | viewportY | af |
|---|------|----------|------|-----------|-----|
| 1 | 23:07 | - | 2 | 993 | undef |
| 2 | 23:09 | 2 min | 16 | 0 | undef |
| 3 | 23:19 | 10 min | 22 | 0 | undef |
| 4 | 23:21 | 1 min | 21 | 898 | undef |

### Key findings

- **Frequency:** ~4 times in 15 minutes (more frequent than initially perceived as "every 30 minutes" — user simply didn't notice stalls shorter than ~2 seconds)
- **Common pattern:** All stalls show `af: "undef"` (no rAF scheduled) and `newW > 0` (writes happened without refresh)
- **viewportY varies:** 993, 0, 0, 898 — no consistent position, but `viewportY: 0` appeared twice, suggesting occasional viewport reset to top
- **Auto-recovery works:** `debouncer.refresh()` recovers the display within the 2-second check interval. User reported no visible stalls while the script was active.
- **MCP headless browser:** 6000+ writes without occurrence. Stall only reproduced on the user's regular browser, suggesting the trigger involves user interaction patterns or browser-specific behavior.
- **Agent workers only:** Stall only occurs with Agent workers (Claude Code TUI), never with plain Terminal workers. Claude Code uses alternate screen buffer and complex ANSI escape sequences.

### Hypothesis: alternate screen buffer switching

Claude Code uses `\x1b[?1049h` / `\x1b[?1049l` to switch between alternate and normal screen buffers. When the buffer switches back to normal:
1. `viewportY` resets to the normal buffer's position (possibly 0)
2. `debouncer.refresh()` may not be called for subsequent writes
3. Display freezes until something (resize, manual refresh) restarts the render pipeline

This is consistent with the `viewportY: 0` observations and the fact that only Agent workers (TUI applications) are affected.

## Environment

- **xterm.js:** v5.5.0
- **Renderer:** DOM (not Canvas/WebGL)
- **Browser:** Chrome (via Chrome DevTools MCP)
- **Occurrence:** ~4 times per 15 minutes during active Agent output. Agent workers only.
- **Recovery:** Browser resize, or `debouncer.refresh()` call (confirmed effective)

## Next Steps

1. **Implement auto-recovery in Terminal.tsx:** Periodic check (every 2 seconds) that detects writes without refresh and calls `debouncer.refresh()`. This is a targeted fix using xterm.js internals, not a blind periodic refresh. Verified effective — user could not perceive any stalls with the script running.
2. **Root cause (future):** Investigate why `debouncer.refresh()` stops being called. Likely related to alternate screen buffer switching in Claude Code's TUI output. Consider filing an xterm.js issue if reproducible outside this application.

## Diagnostic Scripts

### Stall Detector v4 — NO_REFRESH only (paste into browser DevTools console)

Hooks `terminal.write()` and `debouncer.refresh()` to detect when writes happen but refresh is not called. Auto-recovers via `debouncer.refresh()` (lightweight, no performance impact). Survives tab switches by re-hooking when the xterm instance changes. Logs snapshots to `window.__stallLog` for post-mortem.

```javascript
(() => {
  let currentTerminal = null;
  let currentDebouncer = null;
  let origWrite = null;
  let origRefresh = null;
  let wCount = 0, rCount = 0, lastW = 0, lastR = 0, stallCount = 0;
  window.__stallLog = [];

  function findTerminal() {
    const x = document.querySelector('.xterm');
    if (!x?.parentElement) return null;
    const f = Object.keys(x.parentElement).find(k => k.startsWith('__reactFiber'));
    if (!f) return null;
    let c = x.parentElement[f];
    while (c) {
      if (c.memoizedState) {
        let h = c.memoizedState;
        while (h) {
          const v = h.memoizedState;
          if (v?.current?.write && typeof v.current.cols === 'number') return v.current;
          h = h.next;
        }
      }
      c = c.return;
    }
    return null;
  }

  function hookTerminal(t) {
    if (currentTerminal === t) return;
    currentTerminal = t;
    const db = t._core?._renderService?._renderDebouncer;
    if (!db) return;
    currentDebouncer = db;
    wCount = 0; rCount = 0; lastW = 0; lastR = 0;
    origWrite = t.write.bind(t);
    t.write = function(d, cb) { wCount++; return origWrite(d, cb); };
    origRefresh = db.refresh.bind(db);
    db.refresh = function(s, e) { rCount++; return origRefresh(s, e); };
    console.warn('[STALL-DET] Hooked', t.cols + 'x' + t.rows);
  }

  setInterval(() => {
    const t = findTerminal();
    if (!t) return;
    if (t !== currentTerminal) hookTerminal(t);
    if (!currentDebouncer) return;
    const newW = wCount - lastW;
    const newR = rCount - lastR;
    if (newW > 0 && newR === 0) {
      stallCount++;
      const snap = {
        n: stallCount,
        time: new Date().toISOString(),
        w: wCount, r: rCount, newW,
        af: currentDebouncer._animationFrame ?? 'undef',
        isPaused: currentTerminal._core?._renderService?._isPaused,
        baseY: currentTerminal.buffer?.active?.baseY,
        viewportY: currentTerminal.buffer?.active?.viewportY,
        visibility: document.visibilityState,
      };
      window.__stallLog.push(snap);
      console.warn('[STALL] #' + stallCount + ' NO_REFRESH', snap);
      currentDebouncer.refresh(0, currentTerminal.rows - 1);
    }
    lastW = wCount; lastR = rCount;
  }, 2000);

  console.warn('[STALL-DET] v4 installed. NO_REFRESH detection only.');
})();
```

After a stall resolves (e.g., by resizing the browser), run `window.__stallLog` in the console to see captured snapshots.

**Discarded approaches:**
- `_animationFrame === undefined` check: false positive — `_animationFrame` is normally `undefined` after rAF fires
- `DOM_FROZEN` (DOM fingerprint check): false positive — Claude Code's TUI status bar at the bottom doesn't change even during normal updates. Also, the resize recovery caused noticeable input lag.

## Diagnostic Tools Used

- **Chrome DevTools MCP:** `evaluate_script` to inject debugging code at runtime
- **No file modifications needed** — all debugging was done via runtime injection
- **PR #360:** Optional diagnostic logging (localStorage-based, zero overhead when disabled)

## Related Files

| File | Role |
|------|------|
| `packages/client/src/components/Terminal.tsx` | Terminal component, calls `terminal.write()` |
| `packages/client/src/lib/render-diagnostics.ts` | Diagnostic logging utility (PR #360) |
| `node_modules/@xterm/xterm/src/browser/services/RenderService.ts` | xterm.js render service |
| `node_modules/@xterm/xterm/src/browser/RenderDebouncer.ts` | xterm.js render debouncer |
