import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { TerminalView } from '../TerminalView';
import type { TerminalInstance, TerminalSnapshot } from '../terminal-store';
import { getOrCreateTerminal, _resetTerminals, _inspect } from '../terminal-store';
import type { TerminalRow } from '../buffer-to-rows';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';

// A fixed snapshot exercising the renderer's core row contract: a plain segment,
// a styled segment (bold + fg color), and a decorator-attached link segment.
const ROWS: TerminalRow[] = [
  {
    key: 0,
    isWrapped: false,
    links: [],
    segments: [
      { text: 'hello ', style: null },
      { text: 'world', style: { bold: true, fg: '#ff0000' } },
    ],
  },
  {
    key: 1,
    isWrapped: false,
    links: [],
    segments: [
      { text: 'see ', style: null },
      { text: '#123', style: null, link: { href: 'https://github.com/acme/widgets/issues/123' } },
    ],
  },
];

function makeSnapshot(rows: TerminalRow[]): TerminalSnapshot {
  return {
    version: 1,
    status: 'connected',
    exitInfo: null,
    rows,
    cursor: { x: 0, y: 0, visible: true },
    cols: 80,
    terminalRows: 24,
    bufferType: 'normal',
    mouseTracking: false,
    notice: null,
    workerError: null,
    activityState: null,
    loadingHistory: false,
    loadingOlder: false,
    canRequestOlder: false,
    pagedRowCount: 0,
    pagedTopChunkRowCount: 0,
    pagedCapReached: false,
    retentionFloorReached: false,
  };
}

// Stub instance backed by a fixed snapshot (stable reference so
// useSyncExternalStore does not loop). The view only reads the snapshot.
function makeInstance(snapshot: TerminalSnapshot): TerminalInstance {
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    sendInput: () => {},
    resize: () => {},
    forwardScroll: () => {},
    reportMouseButton: () => {},
    paste: () => {},
    getApplicationCursorMode: () => false,
    retry: () => {},
    dismissNotice: () => {},
    requestOlderHistory: () => {},
    evictTopChunk: () => {},
    acquire: () => () => {},
    dispose: () => {},
  };
}

describe('TerminalView row rendering', () => {
  afterEach(cleanup);

  it('renders each row segment as text', () => {
    render(<TerminalView instance={makeInstance(makeSnapshot(ROWS))} />);

    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('world')).toBeTruthy();
    expect(screen.getByText('see')).toBeTruthy();
  });

  it('applies a segment style (bold + foreground color) to the styled span', () => {
    render(<TerminalView instance={makeInstance(makeSnapshot(ROWS))} />);

    const styled = screen.getByText('world');
    expect(styled.style.fontWeight).toBe('bold');
    // happy-dom may serialize the hex as rgb(); accept either representation.
    const styleAttr = styled.getAttribute('style') ?? '';
    expect(styleAttr.includes('255, 0, 0') || styleAttr.toLowerCase().includes('ff0000')).toBe(true);
  });

  it('renders a link segment as an anchor with href, target and rel', () => {
    render(<TerminalView instance={makeInstance(makeSnapshot(ROWS))} />);

    const link = screen.getByText('#123');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/123');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

// Layout-dependent geometry (scrollTop / clientHeight) is not produced by
// happy-dom, so these tests define it explicitly on the scroll container. The
// precise anchor-rect physics are verified by the coordinator's E2E; here we
// assert only the trigger wiring: scroll-at-top + canRequestOlder -> the store
// method fires, and the gate holds when the store says paging is not allowed.
describe('TerminalView history-paging trigger', () => {
  afterEach(cleanup);

  function setGeometry(el: HTMLElement, scrollTop: number) {
    Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  }

  it('requests older history when scrolled near the top and paging is allowed', () => {
    const requestOlderHistory = mock(() => {});
    const snapshot = { ...makeSnapshot(ROWS), canRequestOlder: true };
    const instance = { ...makeInstance(snapshot), requestOlderHistory };
    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    setGeometry(scroller, 50); // 50 < 2 * clientHeight (200) -> near the top
    fireEvent.scroll(scroller);
    expect(requestOlderHistory).toHaveBeenCalled();
  });

  it('does not request older history when the store disallows it', () => {
    const requestOlderHistory = mock(() => {});
    const snapshot = { ...makeSnapshot(ROWS), canRequestOlder: false };
    const instance = { ...makeInstance(snapshot), requestOlderHistory };
    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    setGeometry(scroller, 50);
    fireEvent.scroll(scroller);
    expect(requestOlderHistory).not.toHaveBeenCalled();
  });

  it('does not request older history when scrolled far from the top', () => {
    const requestOlderHistory = mock(() => {});
    const snapshot = { ...makeSnapshot(ROWS), canRequestOlder: true };
    const instance = { ...makeInstance(snapshot), requestOlderHistory };
    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    setGeometry(scroller, 500); // 500 >= 200 -> not near the top
    fireEvent.scroll(scroller);
    expect(requestOlderHistory).not.toHaveBeenCalled();
  });

  it('shows the cap-reached notice overlay', () => {
    const snapshot = { ...makeSnapshot(ROWS), pagedCapReached: true };
    render(<TerminalView instance={makeInstance(snapshot)} />);
    expect(screen.getByText(/older history paused/i)).toBeTruthy();
  });

  it('shows the retention-floor notice when the server evicted older history (#980)', () => {
    const snapshot = { ...makeSnapshot(ROWS), retentionFloorReached: true };
    render(<TerminalView instance={makeInstance(snapshot)} />);
    expect(screen.getByText(/no longer retained/i)).toBeTruthy();
  });

  it('prefers the cap notice over the retention-floor notice (#980 precedence)', () => {
    const snapshot = {
      ...makeSnapshot(ROWS),
      pagedCapReached: true,
      retentionFloorReached: true,
    };
    render(<TerminalView instance={makeInstance(snapshot)} />);
    expect(screen.getByText(/older history paused/i)).toBeTruthy();
    expect(screen.queryByText(/no longer retained/i)).toBeNull();
  });

  it('renders no retention-floor notice when the floor is not reached (#980)', () => {
    const snapshot = { ...makeSnapshot(ROWS), retentionFloorReached: false };
    render(<TerminalView instance={makeInstance(snapshot)} />);
    expect(screen.queryByText(/no longer retained/i)).toBeNull();
  });
});

// --- #959 eviction self-cannibalization ---
//
// These tests drive the scroll-anchoring / §6.4-eviction machinery that lives in
// TerminalView. happy-dom produces no layout, so a deterministic geometry is
// installed on the scroll container: a fixed clientHeight, a scrollHeight derived
// from the live child-row count (each row div is exactly LINE_HEIGHT_PX = 18px),
// and a scrollTop accessor that clamps like a real scroller AND synchronously
// dispatches a 'scroll' event on any real change — emulating the browser firing
// scroll events for programmatic scrollTop writes, the exact mechanism the bug
// rides on.
const LINE_HEIGHT_PX = 18;

function installGeometry(el: HTMLElement, clientHeight: number) {
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get() {
      return el.children.length * LINE_HEIGHT_PX;
    },
  });
  let backing = 0;
  let dispatching = false;
  const clamp = (v: number) => {
    const max = Math.max(0, el.scrollHeight - clientHeight);
    return Math.min(max, Math.max(0, v));
  };
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get() {
      return backing;
    },
    set(v: number) {
      const next = clamp(v);
      if (next === backing) return; // no change -> no scroll event (browser parity)
      backing = next;
      if (dispatching) return; // guard against re-entrant dispatch loops
      dispatching = true;
      try {
        el.dispatchEvent(new Event('scroll'));
      } finally {
        dispatching = false;
      }
    },
  });
  // Position the viewport without firing a scroll event (test setup convenience).
  return {
    setSilent(v: number) {
      backing = clamp(v);
    },
  };
}

// Geometry whose scrollTop getter RE-CLAMPS against the CURRENT scrollHeight on
// every read — emulating the browser clamping scrollTop when content SHRINKS
// (rows removed at the top by an eviction) BEFORE layout effects run. `backing`
// holds the last requested (unclamped) intent, so a shrink reduces what the
// getter returns without any explicit write. The growth-only tests keep using
// installGeometry (set-time clamp) so their bottom-pin math is unaffected.
function installShrinkClampGeometry(el: HTMLElement, clientHeight: number) {
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get() {
      return el.children.length * LINE_HEIGHT_PX;
    },
  });
  let backing = 0;
  let dispatching = false;
  const effective = () => {
    const max = Math.max(0, el.scrollHeight - clientHeight);
    return Math.min(max, Math.max(0, backing));
  };
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get() {
      return effective();
    },
    set(v: number) {
      const prev = effective();
      backing = v;
      if (effective() === prev) return; // no visible change -> no scroll event
      if (dispatching) return;
      dispatching = true;
      try {
        el.dispatchEvent(new Event('scroll'));
      } finally {
        dispatching = false;
      }
    },
  });
  return {
    setSilent(v: number) {
      backing = v;
    },
  };
}

function flush(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastRangeRequest(ws: MockWebSocket): { requestId: number; [k: string]: unknown } | undefined {
  const msgs = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string) as { type: string; [k: string]: unknown });
  return [...msgs].reverse().find((m) => m.type === 'request-history-range') as
    | { requestId: number; [k: string]: unknown }
    | undefined;
}

function makeRows(count: number, negCount: number): TerminalRow[] {
  return Array.from({ length: count }, (_, i) => ({
    key: i < negCount ? -(i + 1) : i,
    isWrapped: false,
    links: [],
    segments: [{ text: `row${i}`, style: null }],
  }));
}

describe('TerminalView #959 eviction self-cannibalization (real store integration)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: PropertyDescriptor | undefined;
  let originalRaf: typeof globalThis.requestAnimationFrame;

  beforeEach(() => {
    // Defensive against cross-file registry leakage before installing the mock WS
    // (module-mock poisoning is fixed at the poisoners; this cannot defend that).
    _resetTerminals();
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
    // The store schedules its snapshot rebuild on requestAnimationFrame, one
    // frame AFTER the synchronous syncPagingMeta notify. In production that frame
    // boundary lets React commit the premature-count render before the rebuild
    // lands (the exact window Defect A exploits). happy-dom's rAF fires so fast
    // that React coalesces both notifies into one render, hiding the bug. Defer
    // rAF to a macrotask so the frame boundary is real and the premature render
    // commits first — faithfully modeling production timing.
    originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(performance.now()), 50) as unknown as number;
    }) as typeof globalThis.requestAnimationFrame;
  });

  afterEach(() => {
    cleanup();
    _resetTerminals();
    restoreWebSocket();
    globalThis.requestAnimationFrame = originalRaf;
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it('keeps a just-applied history-range chunk instead of cannibalizing it', async () => {
    const instance = getOrCreateTerminal('s', 'w');
    // Neutralize the ResizeObserver-driven resize: happy-dom yields garbage
    // geometry (NaN cols), which would corrupt the chunk's row geometry. We test
    // paging here, not resize; keep the terminal at its default 80 cols so the
    // 700 short lines never wrap. The object is still the real controller so
    // _inspect() (prototype getters) keeps working.
    instance.resize = () => {};

    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('no ws');
    ws.simulateOpen();

    // Seed ~60 lines of live history at a non-zero absolute start (47044).
    const liveLines = Array.from({ length: 60 }, (_, i) => `L${String(701 + i).padStart(4, '0')}`).join('\r\n');
    await act(async () => {
      ws.simulateMessage(
        JSON.stringify({
          type: 'history',
          data: liveLines,
          offset: 47044 + liveLines.length,
          startOffset: 47044,
          epoch: 1000,
        }),
      );
      await flush(80);
    });
    expect(instance.getSnapshot().canRequestOlder).toBe(true);

    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    installGeometry(scroller, 180);

    // User scrolls near the top -> the view requests older history.
    await act(async () => {
      scroller.scrollTop = 100;
      await flush(40);
    });
    const req = lastRangeRequest(ws);
    expect(req).toBeDefined();

    // Server replies with a single big chunk covering [0, 47044): 700 short lines.
    const oldLines = Array.from({ length: 700 }, (_, i) => `L${String(i + 1).padStart(4, '0')}`).join('\r\n');
    // Split the delivery across two commit checkpoints. The first act lets
    // applyRangeChunk resolve and fire the synchronous syncPagingMeta notify
    // (the premature-count state), then commits it — but ends BEFORE the deferred
    // (50ms) rebuild rAF, so React cannot coalesce the two into one render. The
    // second act lets the rebuild land. On current code the premature render's
    // anchor compensation + bottom-follow pin then evicts the chunk here; the fix
    // makes both renders atomic so the chunk survives.
    await act(async () => {
      ws.simulateMessage(
        JSON.stringify({
          type: 'history-range',
          requestId: req?.requestId,
          data: oldLines,
          startOffset: 0,
          endOffset: 47044,
          hasMore: false,
          epoch: 1000,
        }),
      );
      await flush(25); // < 50ms rAF: commit the premature-count render first
    });
    await act(async () => {
      await flush(200); // rebuild rAF + any eviction-triggered rebuild
    });

    // The chunk MUST survive (current code evicts it within one render cycle).
    const paging = _inspect(instance).paging;
    expect(paging.pagedChunkCount).toBe(1);
    expect(paging.oldestOffset).toBe(0);
    expect(instance.getSnapshot().rows[0].key).toBeLessThan(0);
    expect(scroller.textContent).toContain('L0001');
    // Anchor compensation kept the viewport stable: 700 prepended rows * 18px.
    expect(scroller.scrollTop).toBe(100 + 700 * LINE_HEIGHT_PX);
  });
});

describe('TerminalView §6.4 eviction gating (#959)', () => {
  afterEach(cleanup);

  it('does NOT evict when the component pins the viewport programmatically', () => {
    const evictTopChunk = mock(() => {});
    const rows = makeRows(760, 700); // 700 paged (neg-key) + 60 live rows
    let snap: TerminalSnapshot = {
      ...makeSnapshot(rows),
      pagedRowCount: 700,
      pagedTopChunkRowCount: 700,
    };
    const listeners = new Set<() => void>();
    const instance: TerminalInstance = {
      ...makeInstance(snap),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getSnapshot: () => snap,
      evictTopChunk,
    };
    const setSnapshot = (s: TerminalSnapshot) => {
      snap = s;
      for (const l of Array.from(listeners)) l();
    };

    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const geom = installGeometry(scroller, 180);
    // Pin the viewport at the bottom, well below the top chunk's bottom edge.
    geom.setSilent(scroller.scrollHeight); // clamps to max

    // A snapshot change that adds a live row grows scrollHeight; while at the
    // bottom the component's OWN bottom-follow effect writes scrollTop via
    // assignScrollTop, firing a programmatic scroll event. §6.4 must NOT evict on
    // it — that is the self-cannibalization the fix prevents.
    act(() => {
      setSnapshot({
        ...makeSnapshot(makeRows(761, 700)),
        pagedRowCount: 700,
        pagedTopChunkRowCount: 700,
      });
    });

    expect(evictTopChunk).not.toHaveBeenCalled();
  });

  it('anchors eviction from the pre-commit scrollTop, not the browser-clamped base', () => {
    const requestOlderHistory = mock(() => {});
    const listeners = new Set<() => void>();
    let snap: TerminalSnapshot = {
      ...makeSnapshot(makeRows(760, 700)), // 700 paged (neg-key) + 60 live
      pagedRowCount: 700,
      pagedTopChunkRowCount: 700,
      canRequestOlder: true,
    };
    const instance: TerminalInstance = {
      ...makeInstance(snap),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getSnapshot: () => snap,
      requestOlderHistory,
    };
    const setSnapshot = (s: TerminalSnapshot) => {
      snap = s;
      for (const l of Array.from(listeners)) l();
    };

    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const geom = installShrinkClampGeometry(scroller, 180);
    // User genuinely scrolled 100px past the eviction threshold:
    // chunkBottom(700*18=12600) + 2*clientHeight(360) + 100 = 13060.
    geom.setSilent(700 * LINE_HEIGHT_PX + 2 * 180 + 100);

    // Publish the post-eviction snapshot: the 700 paged rows are gone, 60 live
    // rows remain. The DOM shrinks, so the browser clamps scrollTop to the new
    // max (900) before the anchor layout effect runs.
    act(() => {
      setSnapshot({
        ...makeSnapshot(makeRows(60, 0)),
        pagedRowCount: 0,
        pagedTopChunkRowCount: 0,
        canRequestOlder: true,
      });
    });

    // The anchor must compensate from the PRE-COMMIT base (13060), preserving the
    // user's position: 13060 - 700*18 = 460 — NOT the browser-clamped base
    // (900 -> 900-12600 -> clamped 0). 460 stays outside the fetch trigger
    // (>= 2*180 = 360), so no self-defeating re-fetch of the just-evicted chunk.
    expect(scroller.scrollTop).toBe(460);
    expect(requestOlderHistory).not.toHaveBeenCalled();
  });

  it('anchors a pair re-replay row-count change without triggering eviction (§6.2)', () => {
    // A seam-correction pair re-replay REPLACES the top chunks' rows, changing
    // pagedRowCount N -> N' atomically with the rows. The anchor must compensate
    // by (N'-N)*LINE_HEIGHT_PX from the pre-commit base, and the compensating
    // (programmatic) scroll must NOT trip §6.4 eviction — even when the resulting
    // position is eviction-worthy — because it was our own write, not the user's.
    const evictTopChunk = mock(() => {});
    const requestOlderHistory = mock(() => {});
    const listeners = new Set<() => void>();
    let snap: TerminalSnapshot = {
      ...makeSnapshot(makeRows(760, 700)), // 700 paged + 60 live
      pagedRowCount: 700,
      pagedTopChunkRowCount: 700,
      canRequestOlder: true,
    };
    const instance: TerminalInstance = {
      ...makeInstance(snap),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getSnapshot: () => snap,
      evictTopChunk,
      requestOlderHistory,
    };
    const setSnapshot = (s: TerminalSnapshot) => {
      snap = s;
      for (const l of Array.from(listeners)) l();
    };

    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const geom = installGeometry(scroller, 180);
    // Park the user well below the top chunk's bottom — an eviction-worthy spot
    // for a GENUINE scroll: scrollTop(13060) - chunkBottom(700*18=12600) = 460 >=
    // 2*clientHeight(360). The compensation write lands here-plus-delta.
    geom.setSilent(700 * LINE_HEIGHT_PX + 2 * 180 + 100); // 13060

    // Pair re-replay grows the paged region by 5 rows (seam-corrected partition).
    act(() => {
      setSnapshot({
        ...makeSnapshot(makeRows(765, 705)),
        pagedRowCount: 705,
        pagedTopChunkRowCount: 705,
        canRequestOlder: true,
      });
    });

    // Anchor compensated from the pre-commit base by the +5-row delta.
    expect(scroller.scrollTop).toBe(13060 + 5 * LINE_HEIGHT_PX); // 13150
    // The programmatic gate held: no self-cannibalizing eviction, no re-fetch.
    expect(evictTopChunk).not.toHaveBeenCalled();
    expect(requestOlderHistory).not.toHaveBeenCalled();
  });

  it('a no-op programmatic write does not suppress a subsequent genuine user eviction', () => {
    const evictTopChunk = mock(() => {});
    const listeners = new Set<() => void>();
    let snap: TerminalSnapshot = {
      ...makeSnapshot(makeRows(760, 700)),
      pagedRowCount: 700,
      pagedTopChunkRowCount: 700,
    };
    const instance: TerminalInstance = {
      ...makeInstance(snap),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getSnapshot: () => snap,
      evictTopChunk,
    };
    const setSnapshot = (s: TerminalSnapshot) => {
      snap = s;
      for (const l of Array.from(listeners)) l();
    };

    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const geom = installGeometry(scroller, 180);
    geom.setSilent(scroller.scrollHeight); // pin exactly at the (clamped) bottom

    // A snapshot bump while already exactly at the bottom makes bottom-follow
    // write scrollTop = scrollHeight, which clamps to the SAME value: a NO-OP
    // programmatic write that fires no scroll event. assignScrollTop must UNFLAG
    // on this no-op — otherwise the stale programmatic flag would suppress the
    // NEXT genuine scroll's eviction. (paged count unchanged, so the anchor
    // effect is a no-op and only bottom-follow runs.)
    act(() => {
      setSnapshot({
        ...makeSnapshot(makeRows(760, 700)),
        pagedRowCount: 700,
        pagedTopChunkRowCount: 700,
      });
    });

    // Genuine user scroll: still far below the chunk bottom (13500 - 12600 = 900
    // >= 2*180), so §6.4 must evict — the no-op write must not have latched the
    // programmatic flag.
    fireEvent.scroll(scroller);
    expect(evictTopChunk).toHaveBeenCalled();
  });

  it('DOES evict on a genuine user scroll away from the chunk', () => {
    const evictTopChunk = mock(() => {});
    const snapshot = { ...makeSnapshot(ROWS), pagedTopChunkRowCount: 700 };
    const instance = { ...makeInstance(snapshot), evictTopChunk };
    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    // A plain user scroll (no preceding programmatic write): scrollTop is far
    // below the chunk bottom (700*18=12600): 13000-12600=400 >= 2*180.
    Object.defineProperty(scroller, 'clientHeight', { value: 180, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 20000, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 13000, writable: true, configurable: true });
    fireEvent.scroll(scroller);
    expect(evictTopChunk).toHaveBeenCalled();
  });
});
