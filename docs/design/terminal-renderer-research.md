# Terminal Renderer Architecture Research

**Issue:** #555
**Date:** 2026-04-04
**Status:** Research complete

## Motivation

agent-console uses xterm.js (v5.5.0) as its terminal renderer. As we build an AI agent management UI, we encounter use cases that go beyond traditional terminal emulation:

- **System message filtering**: `[internal:*]` messages and `[Reply Instructions]` blocks are stripped via regex before reaching xterm.js (#551). This works but is fragile (regex-based, no UI affordance for show/hide).
- **Render stall recovery**: xterm.js's render pipeline occasionally stalls, requiring a custom auto-recovery mechanism that hooks internal APIs (#369).
- **Rich agent UI**: We want collapsible output sections, activity indicators, and structured content — features that don't map to a VT100 terminal model.

This document evaluates whether forking xterm.js or building a custom renderer would serve these needs better than the current addon-based approach.

## 1. xterm.js Addon API Limits

### What addons CAN do

The addon API is built on a simple `ITerminalAddon` interface:

```typescript
interface ITerminalAddon extends IDisposable {
  activate(terminal: Terminal): void;
}
```

Once activated, an addon has full access to the `Terminal` instance, including:

- **Parser hooks** (`terminal.parser`): Intercept CSI, DCS, ESC, and OSC sequences before they reach the buffer. Return `true` to consume, `false` to pass through. Supports async handlers.
- **Buffer API** (`terminal.buffer`): Read-only access to buffer content, cursor position, cell attributes, and colors. Navigate normal and alternate buffers.
- **Decoration API** (`terminal.registerDecoration`): Attach DOM elements to buffer lines via markers. Decorations track line position as the buffer scrolls.
- **Link Provider** (`terminal.registerLinkProvider`): Custom link detection with hover/click handlers.
- **Character Joiner** (`terminal.registerCharacterJoiner`): Custom glyph grouping for ligatures (Canvas renderer only).
- **Marker API** (`terminal.registerMarker`): Track buffer positions that adjust as content scrolls.
- **Pluggable renderer**: The `IRenderer` interface allows complete renderer replacement (Canvas and WebGL renderers are implemented this way).

### What addons CANNOT do

- **Hide or collapse buffer lines**: The buffer is a flat array of rows. There is no API to skip, fold, or virtually hide lines. Decorations are overlays — the underlying rows still occupy vertical space.
- **Modify buffer content after write**: The buffer API is read-only. Once data is written, it cannot be modified or removed except by clearing and rewriting.
- **Decouple viewport rows from buffer rows**: The renderer assumes a 1:1 mapping between viewport rows and buffer rows. A custom renderer would need to break this contract to support folding.

## 2. registerDecoration API Assessment

### API Surface

```typescript
terminal.registerDecoration({
  marker: IMarker,          // Anchors to a buffer line
  anchor?: 'left' | 'right',
  x?: number,               // Cell offset from anchor
  width?: number,           // Width in cells (default: 1)
  height?: number,          // Height in cells (default: 1)
  backgroundColor?: string, // #RRGGBB
  foregroundColor?: string, // #RRGGBB
  layer?: 'bottom' | 'top',
}): IDecoration | undefined

interface IDecoration {
  readonly marker: IMarker;
  readonly onRender: IEvent<HTMLElement>;  // Access DOM element when rendered
  element: HTMLElement | undefined;
}
```

### Feasibility for System Message Collapsing

**Cannot achieve true line folding.** Decorations overlay content but cannot remove lines from the viewport. A decoration with `height: 1` covering a 5-line system message would still leave 4 visible blank/content rows.

**What IS possible with decorations:**

1. **Visual annotation**: Place a "system message" badge next to `[internal:*]` lines. This adds context but doesn't reduce visual noise.
2. **Overlay masking**: Cover system message lines with a styled decoration (e.g., a collapsed summary bar). However, the lines still take vertical space, and the overlay DOM element must be sized precisely — fragile with varying terminal widths and font metrics.
3. **Section markers**: Mark the start/end of agent output sections with clickable expand/collapse buttons. The collapse action would need to rewrite the buffer (clear + rewrite without hidden lines), which is destructive and loses cursor/scroll state.

### Performance

- Each decoration creates a real DOM element in a separate layer.
- VS Code uses decorations for shell integration markers (tens per viewport) — this is well-tested.
- Hundreds of decorations per viewport would degrade performance due to DOM layout/paint costs.
- A multi-line decoration height bug existed (xterm.js #4855), fixed in the upcoming 7.0.0 release.

**Conclusion:** `registerDecoration` is unsuitable for collapsible system messages. It works well for sparse annotations (command markers, error highlights) but cannot hide or fold lines.

## 3. Fork vs Custom Renderer vs Addon-Only

### Option A: Addon-Only (Current Approach, Enhanced)

**Approach:** Continue pre-filtering output before it reaches xterm.js. Enhance with decorations for sparse UI elements.

**What we gain:**
- Zero maintenance burden — track upstream xterm.js releases normally
- Current system message filtering (#551) already works
- Can add decorations for section markers, activity indicators
- Parser hooks can implement custom OSC sequences for agent-to-UI communication

**What we can't do:**
- True line folding/collapsing within the terminal viewport
- Rich structured content (tables, charts, images) inline with terminal output
- Dynamic show/hide of system messages without buffer rewrite

**Enhancement opportunities:**
- Define custom OSC sequences (e.g., `OSC 1337 ; section=start ST`) that agents emit to mark output sections. Parser hooks detect these and create decoration markers.
- Use a "two-layer" architecture: raw PTY data → filter/transform layer → xterm.js. The filter layer can be toggled (show/hide system messages) by clearing and rewriting the buffer.

**Effort:** S (Small) — incremental improvements to existing architecture.

### Option B: Fork xterm.js

**Approach:** Fork xterm.js to add buffer-level line folding and virtual viewport support.

**What we gain:**
- True line collapsing: folded lines take zero vertical space
- Native integration with xterm.js's rendering pipeline
- Potentially upstream-able if designed well (xterm.js #1875 is an open feature request for text folding)

**What it costs:**
- **Maintenance burden**: xterm.js has active development. Keeping a fork in sync requires rebasing across core buffer, renderer, and parser changes. The buffer module is deeply integrated with rendering — modifications here touch the most change-prone code.
- **Scope of changes**: Line folding requires modifying:
  - `Buffer` and `BufferLine` to track fold state
  - `Viewport` to calculate visible rows with folds
  - `RenderService` to skip folded rows
  - Scroll calculations, selection, search — all assume contiguous rows
- **Testing**: xterm.js has extensive tests. Fork modifications need equivalent coverage.
- **Risk**: Our render stall issue (#369) shows that xterm.js internals are fragile. Adding complexity to the render pipeline increases the risk of subtle bugs.

**Effort:** L-XL (Large to Extra-Large) — significant engineering investment with ongoing maintenance.

### Option C: Custom Renderer from Scratch

**Approach:** Build a terminal renderer that natively supports structured content, folding, and rich decorations.

**What we gain:**
- Full control over rendering, folding, and structured content
- No dependency on xterm.js's architecture constraints
- Can design for AI agent UI from the ground up (not constrained by VT100 model)

**What it costs:**
- **VT100/xterm escape sequence parsing**: This is the hardest part. xterm.js implements hundreds of escape sequences across CSI, DCS, ESC, OSC, and private modes. Reimplementing this correctly is a multi-person-year effort.
- **Rendering performance**: xterm.js invested years in canvas/WebGL rendering for performance. A DOM-based custom renderer would need similar optimization.
- **Compatibility**: Agent tools (Claude Code, etc.) emit complex ANSI output including alternate screen buffer, mouse tracking, and TUI frameworks. A custom renderer must handle all of this.
- **No ecosystem**: Lose all xterm.js addons (fit, serialize, web-links, search).

**Partial alternative — use xterm.js parser, custom renderer:**
- xterm.js's `IRenderer` interface allows plugging in a custom renderer while keeping the parser and buffer
- However, the renderer API assumes 1:1 buffer-row-to-viewport-row mapping
- Breaking this assumption means fighting the API, not using it

**Effort:** XL-XXL (Extra-Large) — essentially building a new terminal emulator.

### Comparison Matrix

| Criteria | Addon-Only | Fork | Custom Renderer |
|----------|-----------|------|-----------------|
| System message hiding (pre-filter) | ✅ Works today | ✅ Works today | ✅ Full control |
| True line folding | ❌ Not possible | ✅ With buffer mods | ✅ Full control |
| Rich structured content | ❌ Limited to overlays | ⚠️ Requires renderer mods | ✅ Full control |
| Maintenance burden | None | High (ongoing rebase) | Very high (own everything) |
| Upstream compatibility | ✅ Full | ⚠️ Diverges over time | ❌ N/A |
| Implementation effort | S | L-XL | XL-XXL |
| Risk | Low | Medium-High | Very High |
| Time to value | Immediate | Months | Many months |

## 4. PoC Assessment: Decoration-Based Section Markers

The following demonstrates what IS achievable with the addon API — section markers with toggle buttons, not true folding:

```typescript
import { Terminal, ITerminalAddon, IMarker, IDecoration } from '@xterm/xterm';

interface Section {
  marker: IMarker;
  decoration: IDecoration;
  startLine: number;
  lineCount: number;
  collapsed: boolean;
}

class SystemMessageAddon implements ITerminalAddon {
  private terminal!: Terminal;
  private sections: Section[] = [];

  activate(terminal: Terminal): void {
    this.terminal = terminal;

    // Register custom OSC handler: OSC 7777 ; section-start ; <id> ; <label> ST
    terminal.parser.registerOscHandler(7777, (data) => {
      const [command, id, label] = data.split(';');
      if (command === 'section-start') {
        this.markSectionStart(id, label);
        return true; // consume the sequence
      }
      if (command === 'section-end') {
        // Section end is a no-op for now — just a semantic marker
        return true;
      }
      return false;
    });
  }

  private markSectionStart(id: string, label: string): void {
    const marker = this.terminal.registerMarker(0);
    if (!marker) return;

    const decoration = this.terminal.registerDecoration({
      marker,
      anchor: 'right',
      width: 20,
      height: 1,
    });

    if (!decoration) return;

    decoration.onRender((element) => {
      element.style.cssText = `
        background: rgba(100, 100, 255, 0.15);
        border-left: 2px solid #6666ff;
        padding: 0 8px;
        font-size: 12px;
        color: #888;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
      `;
      element.textContent = `▸ ${label}`;
      element.title = 'System message section (decoration-only — cannot fold)';
    });

    this.sections.push({
      marker,
      decoration,
      startLine: marker.line,
      lineCount: 0,
      collapsed: false,
    });
  }

  dispose(): void {
    this.sections.forEach(s => {
      s.decoration.dispose();
      s.marker.dispose();
    });
    this.sections = [];
  }
}
```

**Assessment:**
- This addon correctly annotates system message sections with a visual marker.
- The marker tracks its line position as the buffer scrolls.
- **It cannot collapse the section** — the underlying lines remain visible and occupy space.
- To achieve actual collapse, the data would need to be stripped before reaching xterm.js (the current approach in #551), or the buffer would need to be cleared and rewritten without the hidden lines (destructive, loses state).

## 5. Recommendation

### Recommended approach: **Enhanced Addon-Only (Option A)**

**Proceed with incremental improvements to the current architecture.** The analysis shows:

1. **True line folding is not achievable** without forking xterm.js or building a custom renderer. Both alternatives carry disproportionate cost relative to the benefit.

2. **The current pre-filter approach works.** System message stripping (#551) is functional and has comprehensive test coverage (84 test cases). It can be enhanced:
   - Add a toggle mechanism to show/hide system messages by clearing and rewriting the buffer from the server's output history.
   - Use custom OSC sequences for richer agent-to-UI communication (section markers, activity indicators).
   - Add sparse decorations for visual affordances (section badges, error markers).

3. **The real need may not be folding.** The core UX problem is "system messages clutter the terminal." This is already solved by pre-filtering. If users want to see hidden messages, a separate "raw output" view or a log panel alongside the terminal would be simpler and more flexible than inline folding.

4. **xterm.js is the only viable terminal library.** No alternative exists with comparable escape sequence support, rendering performance, and ecosystem. Building our own would be a multi-person-year effort.

### Specific next steps (if pursuing enhancements)

| Enhancement | Effort | Value |
|------------|--------|-------|
| Toggle system message visibility (buffer rewrite from history) | M | High — lets users inspect hidden messages |
| Custom OSC sequences for agent section markers | S | Medium — structured agent output metadata |
| Decoration-based section badges | S | Low — visual polish, no functional change |
| Separate "raw log" panel alongside terminal | M | High — alternative to inline folding |

### When to revisit this decision

- If xterm.js merges the text folding proposal (#1875) — this would enable native folding without a fork
- If a new terminal library emerges with first-class structured content support
- If the product direction shifts to require rich inline content (charts, images, interactive elements) that fundamentally can't work in a terminal model — at that point, consider a hybrid approach with a non-terminal panel for structured content alongside the terminal for raw PTY output

## References

- [xterm.js text folding proposal — Issue #1875](https://github.com/xtermjs/xterm.js/issues/1875)
- [xterm.js pluggable renderer — Issue #2005](https://github.com/xtermjs/xterm.js/issues/2005)
- [xterm.js decoration height bug — Issue #4855](https://github.com/xtermjs/xterm.js/issues/4855)
- [xterm.js OffscreenCanvas perf fix — Issue #5548](https://github.com/xtermjs/xterm.js/issues/5548)
- [DomTerm xterm.js comparison](https://domterm.org/xtermjs.html)
- [agent-console system message filtering — PR #551](https://github.com/ms2sato/agent-console/pull/551)
- [agent-console render stall recovery — PR #369](https://github.com/ms2sato/agent-console/pull/369)
- [agent-console render stall investigation](docs/issues/terminal-render-stall-2026-03-21.md)
