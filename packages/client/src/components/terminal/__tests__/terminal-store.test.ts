import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { AppServerMessage } from '@agent-console/shared';
import { WS_CLOSE_CODE } from '@agent-console/shared';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import {
  getOrCreateTerminal,
  _resetTerminals,
  _setTimings,
  _setAppSubscribe,
  _inspect,
} from '../terminal-store';

/**
 * Capturable app-WS subscribe seam: records every listener the store registers
 * so a test can emit AppServerMessages to all live instances.
 */
function makeAppBus() {
  const listeners = new Set<(msg: AppServerMessage) => void>();
  const subscribe = (listener: (msg: AppServerMessage) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = (msg: AppServerMessage) => {
    for (const l of Array.from(listeners)) l(msg);
  };
  return { subscribe, emit };
}

/** Let write callbacks + the rAF/timeout snapshot flush run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

function lastSentMessages(ws: MockWebSocket): unknown[] {
  const calls = ws.send.mock.calls as unknown as string[][];
  return calls.map((call) => JSON.parse(call[0]));
}

function inputFrames(ws: MockWebSocket): string[] {
  return (lastSentMessages(ws) as { type: string; data?: string }[])
    .filter((m) => m.type === 'input')
    .map((m) => m.data ?? '');
}

function allText(instance: ReturnType<typeof getOrCreateTerminal>): string {
  return instance
    .getSnapshot()
    .rows.map((r) => r.segments.map((s) => s.text).join(''))
    .join('\n');
}

describe('terminal-store', () => {
  let restoreWebSocket: () => void;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    _resetTerminals();
    restoreWebSocket();
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  it('requests full history with fromOffset 0 on open', () => {
    getOrCreateTerminal('s1', 'w1');
    const ws = MockWebSocket.getLastInstance();
    expect(ws).toBeDefined();
    ws!.simulateOpen();

    const sent = lastSentMessages(ws!);
    const history = sent.find((m) => (m as { type: string }).type === 'request-history');
    expect(history).toEqual({ type: 'request-history', fromOffset: 0 });
  });

  it('sends initial resize on open', () => {
    getOrCreateTerminal('s2', 'w2');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const sent = lastSentMessages(ws!);
    const resize = sent.find((m) => (m as { type: string }).type === 'resize');
    expect(resize).toMatchObject({ type: 'resize' });
  });

  it('renders output into snapshot rows and bumps version', async () => {
    const instance = getOrCreateTerminal('s3', 'w3');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const before = instance.getSnapshot().version;
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: 'hello world', offset: 0 }));
    await flush();

    const after = instance.getSnapshot();
    expect(after.version).toBeGreaterThan(before);
    const text = after.rows.map((r) => r.segments.map((s) => s.text).join('')).join('');
    expect(text).toContain('hello world');
  });

  it('renders history message content', async () => {
    const instance = getOrCreateTerminal('s4', 'w4');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(JSON.stringify({ type: 'history', data: 'restored line', offset: 0 }));
    await flush();

    const text = instance
      .getSnapshot()
      .rows.map((r) => r.segments.map((s) => s.text).join(''))
      .join('');
    expect(text).toContain('restored line');
  });

  it('preserves scrollback: CSI 3J in a later output does not erase earlier text', async () => {
    const instance = getOrCreateTerminal('s3j', 'w3j');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    // Push 'first line' above the 24-row screen so it lives in scrollback, which
    // is exactly what raw CSI 3J erases (and the filter preserves).
    const filler = Array.from({ length: 40 }, (_, i) => `filler ${i}`).join('\r\n');
    ws!.simulateMessage(
      JSON.stringify({ type: 'output', data: `first line\r\n${filler}\r\n`, offset: 0 }),
    );
    await flush();
    // A redraw that would normally wipe scrollback via CSI 3J.
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[3Jsecond line', offset: 500 }));
    await flush();

    const text = allText(instance);
    expect(text).toContain('first line');
    expect(text).toContain('second line');
  });

  it('CSI 2J is rewritten to cursor-home + erase-below (post-clear write lands at home)', async () => {
    const instance = getOrCreateTerminal('s2j', 'w2j');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    // Move the cursor down to row 2, then clear + write. The filter rewrites 2J
    // to `\x1b[H\x1b[J`, so the cursor homes and 'after' lands on row 0. Raw 2J
    // leaves the cursor on row 2, so without the filter this assertion fails.
    ws!.simulateMessage(
      JSON.stringify({ type: 'output', data: 'line0\r\nline1\r\nline2', offset: 0 }),
    );
    await flush();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[2Jafter', offset: 17 }));
    await flush();

    const snap = instance.getSnapshot();
    expect(snap.cursor.y).toBe(0); // homed by the 2J rewrite
    expect(snap.rows[0].segments.map((s) => s.text).join('')).toContain('after');
  });

  it('stripScrollbackClear:false leaves CSI 3J in place, so scrollback IS erased', async () => {
    // Polarity vs the always-on default (the '...3J does not erase...' test
    // above): with the filter OFF, raw 3J wipes the scrollback that held the
    // earlier line.
    const instance = getOrCreateTerminal('sNoStrip', 'wNoStrip', { stripScrollbackClear: false });
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const filler = Array.from({ length: 40 }, (_, i) => `filler ${i}`).join('\r\n');
    ws!.simulateMessage(
      JSON.stringify({ type: 'output', data: `first line\r\n${filler}\r\n`, offset: 0 }),
    );
    await flush();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[3Jsecond line', offset: 500 }));
    await flush();

    const text = allText(instance);
    expect(text).not.toContain('first line'); // scrollback erased (filter off)
    expect(text).toContain('second line');
  });

  it('stripScrollbackClear:true preserves scrollback across CSI 3J', async () => {
    const instance = getOrCreateTerminal('sStrip', 'wStrip', { stripScrollbackClear: true });
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const filler = Array.from({ length: 40 }, (_, i) => `filler ${i}`).join('\r\n');
    ws!.simulateMessage(
      JSON.stringify({ type: 'output', data: `first line\r\n${filler}\r\n`, offset: 0 }),
    );
    await flush();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[3Jsecond line', offset: 500 }));
    await flush();

    const text = allText(instance);
    expect(text).toContain('first line');
    expect(text).toContain('second line');
  });

  it('config is fixed per instance lifetime: a later opts value is ignored', async () => {
    // First creation wins (stripScrollbackClear:false). A second getOrCreate with
    // a different flag returns the SAME instance and does NOT change behavior.
    const first = getOrCreateTerminal('sFix', 'wFix', { stripScrollbackClear: false });
    const second = getOrCreateTerminal('sFix', 'wFix', { stripScrollbackClear: true });
    expect(second).toBe(first);

    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    const filler = Array.from({ length: 40 }, (_, i) => `filler ${i}`).join('\r\n');
    ws!.simulateMessage(
      JSON.stringify({ type: 'output', data: `first line\r\n${filler}\r\n`, offset: 0 }),
    );
    await flush();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[3Jsecond line', offset: 500 }));
    await flush();

    // Behavior follows the FIRST call (false -> not stripped -> scrollback erased).
    expect(allText(second)).not.toContain('first line');
  });

  it('retry clears the worker error and opens a fresh connection', async () => {
    const instance = getOrCreateTerminal('sRetry', 'wRetry');
    const firstWs = MockWebSocket.getLastInstance();
    firstWs!.simulateOpen();

    // A recoverable error surfaces (server closes deliberately with SESSION_PAUSED,
    // which also latches noReconnect).
    firstWs!.simulateMessage(
      JSON.stringify({ type: 'error', message: 'paused', code: 'SESSION_PAUSED' }),
    );
    await flush();
    expect(instance.getSnapshot().workerError).not.toBeNull();

    instance.retry();
    await flush();

    // Error cleared and a brand-new WebSocket was opened (reconnect), distinct
    // from the first — proving retry overrides the noReconnect latch.
    expect(instance.getSnapshot().workerError).toBeNull();
    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(firstWs);
    expect(instance.getSnapshot().status).toBe('connecting');
  });

  it('strips [internal:...] system lines from rendered output', async () => {
    const instance = getOrCreateTerminal('sint', 'wint');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(
      JSON.stringify({ type: 'output', data: 'visible\r\n[internal:timer] hidden', offset: 0 }),
    );
    await flush();

    const text = allText(instance);
    expect(text).toContain('visible');
    expect(text).not.toContain('internal:timer');
  });

  it('forwardScroll with mouse tracking active emits SGR wheel reports with clamped coords', async () => {
    const instance = getOrCreateTerminal('smt', 'wmt');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    // Enable mouse tracking (DECSET 1002 = button-event tracking).
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1002h', offset: 0 }));
    await flush();

    instance.forwardScroll(-1, { x: 5, y: 3 }); // scroll up -> button 64
    instance.forwardScroll(2, { x: 5, y: 3 }); // scroll down x2 -> button 65
    // Coords beyond the grid clamp to [1..cols]/[1..rows].
    instance.forwardScroll(1, { x: 9999, y: 9999 });

    const frames = inputFrames(ws!);
    expect(frames).toContain('\x1b[<64;5;3M');
    expect(frames).toContain('\x1b[<65;5;3M\x1b[<65;5;3M');
    // Coords clamped to grid (cols 80, rows 24); never emits the raw 9999.
    expect(frames).toContain('\x1b[<65;80;24M');
  });

  it('forwardScroll without mouse tracking emits arrow keys (CSI A/B)', () => {
    const instance = getOrCreateTerminal('sar', 'war');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    instance.forwardScroll(-2, { x: 1, y: 1 }); // up x2
    instance.forwardScroll(1, { x: 1, y: 1 }); // down x1

    const frames = inputFrames(ws!);
    expect(frames).toContain('\x1b[A\x1b[A');
    expect(frames).toContain('\x1b[B');
  });

  it('forwardScroll without tracking + DECCKM on emits SS3 arrows (ESC O A/B)', async () => {
    const instance = getOrCreateTerminal('sck', 'wck');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    // Application Cursor Keys (DECCKM, DECSET 1).
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1h', offset: 0 }));
    await flush();

    instance.forwardScroll(-1, { x: 1, y: 1 });
    instance.forwardScroll(1, { x: 1, y: 1 });

    const frames = inputFrames(ws!);
    expect(frames).toContain('\x1bOA');
    expect(frames).toContain('\x1bOB');
  });

  it('bufferType appears in snapshot and flips on alt-screen enter/exit', async () => {
    const instance = getOrCreateTerminal('sbt', 'wbt');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    expect(instance.getSnapshot().bufferType).toBe('normal');

    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1049h', offset: 0 }));
    await flush();
    expect(instance.getSnapshot().bufferType).toBe('alternate');

    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1049l', offset: 8 }));
    await flush();
    expect(instance.getSnapshot().bufferType).toBe('normal');
  });

  it('reportMouseButton emits SGR left-button press/release when tracking is on', async () => {
    const instance = getOrCreateTerminal('mb1', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    // Enable button-event tracking (1002) + SGR encoding (1006).
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1002h\x1b[?1006h', offset: 0 }));
    await flush();

    instance.reportMouseButton('press', { x: 5, y: 3 });
    instance.reportMouseButton('release', { x: 5, y: 3 });

    const frames = inputFrames(ws!);
    expect(frames).toContain('\x1b[<0;5;3M'); // press
    expect(frames).toContain('\x1b[<0;5;3m'); // release
  });

  it('reportMouseButton clamps coordinates to the grid', async () => {
    const instance = getOrCreateTerminal('mb2', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1002h', offset: 0 }));
    await flush();

    instance.reportMouseButton('press', { x: 9999, y: 9999 });
    expect(inputFrames(ws!)).toContain('\x1b[<0;80;24M'); // clamped to cols 80, rows 24
  });

  it('reportMouseButton is a no-op when mouse tracking is off', () => {
    const instance = getOrCreateTerminal('mb3', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    instance.reportMouseButton('press', { x: 5, y: 3 });
    instance.reportMouseButton('release', { x: 5, y: 3 });

    // Polarity guard: no SGR mouse frame is sent while tracking is 'none'.
    expect(inputFrames(ws!).some((f) => f.startsWith('\x1b[<0;'))).toBe(false);
  });

  it('mouseTracking flips in the snapshot on DECSET enable / disable', async () => {
    const instance = getOrCreateTerminal('mb4', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    expect(instance.getSnapshot().mouseTracking).toBe(false);

    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1002h', offset: 0 }));
    await flush();
    expect(instance.getSnapshot().mouseTracking).toBe(true);

    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1002l', offset: 8 }));
    await flush();
    expect(instance.getSnapshot().mouseTracking).toBe(false);
  });

  it('paste wraps in bracketed-paste markers and normalizes newlines when DECSET 2004 is on', async () => {
    const instance = getOrCreateTerminal('pst1', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?2004h', offset: 0 }));
    await flush();

    instance.paste('a\nb\r\nc');

    const frames = inputFrames(ws!);
    expect(frames).toContain('\x1b[200~a\rb\rc\x1b[201~'); // wrapped + CR-normalized, one frame
  });

  it('paste sends raw CR-normalized text when bracketed paste is off', () => {
    const instance = getOrCreateTerminal('pst2', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    instance.paste('a\nb\r\nc');

    const frames = inputFrames(ws!);
    expect(frames).toContain('a\rb\rc');
    expect(frames.some((f) => f.includes('\x1b[200~'))).toBe(false);
  });

  it('paste reverts to raw after DECSET 2004 is disabled', async () => {
    const instance = getOrCreateTerminal('pst3', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?2004h', offset: 0 }));
    await flush();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?2004l', offset: 8 }));
    await flush();

    instance.paste('x\ny');

    const frames = inputFrames(ws!);
    expect(frames).toContain('x\ry');
    expect(frames.some((f) => f.includes('\x1b[200~'))).toBe(false);
  });

  it('attaches detected link ranges to snapshot rows', async () => {
    const instance = getOrCreateTerminal('lnk1', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(
      JSON.stringify({ type: 'output', data: 'go http://example.com now', offset: 0 }),
    );
    await flush();

    const rowWithLink = instance.getSnapshot().rows.find((r) => r.links.length > 0);
    expect(rowWithLink).toBeDefined();
    expect(rowWithLink!.links[0].href).toBe('http://example.com');
  });

  it('joins a URL wrapped across rows into one href on the snapshot', async () => {
    const instance = getOrCreateTerminal('lnk2', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    // Longer than the 80-col default -> the terminal soft-wraps it.
    const url = 'http://example.com/' + 'a'.repeat(90);
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: url, offset: 0 }));
    await flush();

    const linkedRows = instance.getSnapshot().rows.filter((r) => r.links.length > 0);
    expect(linkedRows.length).toBeGreaterThanOrEqual(2); // wrapped across >= 2 rows
    for (const r of linkedRows) {
      expect(r.links[0].href).toBe(url); // every wrapped piece carries the full URL
    }
  });

  it('F1: repeated DECSET mode bursts keep the snapshot stable and touch no selection state', async () => {
    const instance = getOrCreateTerminal('f1', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: 'hello world', offset: 0 }));
    await flush();
    const contentBefore = allText(instance);

    // Claude's mode re-send burst, repeated 3x (the #943 F1 pattern).
    const burst = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
    for (let i = 0; i < 3; i++) {
      ws!.simulateMessage(JSON.stringify({ type: 'output', data: burst, offset: 20 + i }));
      await flush();
    }

    expect(instance.getSnapshot().mouseTracking).toBe(true);
    // No reset thrash: rendered content is unchanged across the bursts.
    expect(allText(instance)).toBe(contentBefore);
  });

  it('F2: mouse/scroll reports do not bump the snapshot version (reports are not user input)', async () => {
    const instance = getOrCreateTerminal('f2', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'output', data: '\x1b[?1002h', offset: 0 }));
    await flush();

    const versionBefore = instance.getSnapshot().version;
    instance.reportMouseButton('press', { x: 2, y: 2 });
    instance.reportMouseButton('release', { x: 2, y: 2 });
    instance.forwardScroll(1, { x: 2, y: 2 });
    // Drain a frame: a scheduled notify would bump the version here if a report
    // wrongly triggered one.
    await flush();

    // Reports go out to the PTY only; they must not trigger a React re-render.
    expect(instance.getSnapshot().version).toBe(versionBefore);
  });

  it('sendInput sends a correct input frame', () => {
    const instance = getOrCreateTerminal('s5', 'w5');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    instance.sendInput('ls\r');
    const sent = lastSentMessages(ws!);
    expect(sent).toContainEqual({ type: 'input', data: 'ls\r' });
  });

  it('sets status to exited on exit message', () => {
    const instance = getOrCreateTerminal('s6', 'w6');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(JSON.stringify({ type: 'exit', exitCode: 0, signal: null }));
    const snap = instance.getSnapshot();
    expect(snap.status).toBe('exited');
    expect(snap.exitInfo).toEqual({ code: 0, signal: null });
  });

  it('keeps status exited and does not reconnect when the socket closes after exit', () => {
    const instance = getOrCreateTerminal('s6b', 'w6b');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'exit', exitCode: 0, signal: null }));

    const instancesBefore = MockWebSocket.getInstances().length;
    // A terminated PTY closes the socket right after 'exit'.
    ws!.simulateClose();

    expect(instance.getSnapshot().status).toBe('exited');
    // No reconnect socket was created (a live disconnect would schedule one).
    expect(MockWebSocket.getInstances().length).toBe(instancesBefore);
  });

  it('sets status to disconnected on an unexpected close (contrast: not exited)', () => {
    const instance = getOrCreateTerminal('s6c', 'w6c');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateClose();
    expect(instance.getSnapshot().status).toBe('disconnected');
  });

  it('reuses the same instance for the same session/worker key', () => {
    const a = getOrCreateTerminal('s7', 'w7');
    const b = getOrCreateTerminal('s7', 'w7');
    expect(a).toBe(b);
  });

  it('interface methods survive being destructured (useSyncExternalStore contract)', () => {
    const instance = getOrCreateTerminal('s8', 'w8');
    // React calls these detached from the instance, so `this` must be bound.
    const { subscribe, getSnapshot } = instance;

    expect(() => getSnapshot()).not.toThrow();
    expect(getSnapshot().status).toBe('connecting');

    let notified = 0;
    const unsubscribe = subscribe(() => {
      notified += 1;
    });
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen(); // updateStatus -> notify
    expect(notified).toBeGreaterThan(0);
    expect(() => unsubscribe()).not.toThrow();
  });

  // --- PR-1: protocol hardening ---

  it('does not schedule a reconnect for a non-reconnectable close code', () => {
    const instance = getOrCreateTerminal('rc1', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateClose(1000); // NORMAL_CLOSURE -> shouldReconnect === false

    expect(_inspect(instance).reconnectPending).toBe(false);
    expect(_inspect(instance).reconnectAttempts).toBe(0);
    expect(instance.getSnapshot().status).toBe('disconnected');
  });

  it('schedules a reconnect and counts the attempt for a reconnectable close', () => {
    const instance = getOrCreateTerminal('rc2', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateClose(); // ABNORMAL_CLOSURE (default) -> reconnectable

    expect(_inspect(instance).reconnectPending).toBe(true);
    expect(_inspect(instance).reconnectAttempts).toBe(1);
  });

  it('reconnects on WORKER_RESTARTED (4001) close and re-requests history (unlike NORMAL_CLOSURE)', async () => {
    // The server closes worker sockets with 4001 on restart so the client
    // reconnects onto the new incarnation and re-fetches history (which carries
    // the new epoch). 4001 must be treated as reconnectable — unlike 1000.
    expect(WS_CLOSE_CODE.WORKER_RESTARTED).toBe(4001);
    _setTimings({ reconnectDelayMs: 0 });
    const instance = getOrCreateTerminal('rc-restart', 'w');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();

    ws1!.simulateClose(WS_CLOSE_CODE.WORKER_RESTARTED);
    expect(_inspect(instance).reconnectPending).toBe(true);
    expect(_inspect(instance).reconnectAttempts).toBe(1);
    await flush();

    // A fresh connection is opened and issues a new request-history (the
    // per-connection historyRequested flag resets on connect).
    const ws2 = MockWebSocket.getLastInstance();
    expect(ws2).not.toBe(ws1);
    ws2!.simulateOpen();
    const history = lastSentMessages(ws2!).find(
      (m) => (m as { type: string }).type === 'request-history',
    );
    expect(history).toBeDefined();
  });

  it('re-requests history from lastOffset on reconnect (delta catch-up)', async () => {
    _setTimings({ reconnectDelayMs: 0 });
    getOrCreateTerminal('off1', 'w');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();
    ws1!.simulateMessage(JSON.stringify({ type: 'output', data: 'x', offset: 42 }));
    await flush();

    ws1!.simulateClose(); // reconnectable, 0ms delay
    await flush();

    const ws2 = MockWebSocket.getLastInstance();
    expect(ws2).not.toBe(ws1);
    ws2!.simulateOpen();
    const history = lastSentMessages(ws2!).find(
      (m) => (m as { type: string }).type === 'request-history',
    );
    expect(history).toEqual({ type: 'request-history', fromOffset: 42 });
  });

  it('resets and treats history as full when the response offset regressed (truncation)', async () => {
    _setTimings({ reconnectDelayMs: 0 });
    const instance = getOrCreateTerminal('trunc', 'w');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();
    // First history at a high offset.
    ws1!.simulateMessage(JSON.stringify({ type: 'history', data: 'OLD', offset: 100 }));
    await flush();
    expect(allText(instance)).toContain('OLD');

    ws1!.simulateClose();
    await flush();
    const ws2 = MockWebSocket.getLastInstance();
    ws2!.simulateOpen(); // requests fromOffset=100
    // Server can only serve from offset 50 -> regression -> reset + full.
    ws2!.simulateMessage(JSON.stringify({ type: 'history', data: 'FRESH', offset: 50 }));
    await flush();

    const text = allText(instance);
    expect(text).toContain('FRESH');
    expect(text).not.toContain('OLD');
  });

  it('ignores additive epoch/startOffset fields on history/output (forward-compat)', async () => {
    // PR-A adds `epoch` to output and `startOffset`/`epoch` to history. The
    // current client ignores them (consumed in the PR-C client work); receiving
    // them must not break rendering or offset tracking.
    const instance = getOrCreateTerminal('epoch-additive', 'w');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();
    ws1!.simulateMessage(
      JSON.stringify({ type: 'history', data: 'HELLO', offset: 5, startOffset: 0, epoch: 1782950400000 }),
    );
    ws1!.simulateMessage(
      JSON.stringify({ type: 'output', data: ' WORLD', offset: 11, epoch: 1782950400000 }),
    );
    await flush();
    expect(allText(instance)).toContain('HELLO WORLD');
  });

  it('worker-restarted (app-WS) resets the buffer, reconnects, and shows a notice', async () => {
    const bus = makeAppBus();
    _setAppSubscribe(bus.subscribe);
    const instance = getOrCreateTerminal('wr', 'w');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();
    ws1!.simulateMessage(JSON.stringify({ type: 'output', data: 'before', offset: 10 }));
    await flush();
    expect(allText(instance)).toContain('before');

    bus.emit({ type: 'worker-restarted', sessionId: 'wr', workerId: 'w', activityState: 'idle' });

    expect(instance.getSnapshot().notice).toBe('Terminal restarted');
    const ws2 = MockWebSocket.getLastInstance();
    expect(ws2).not.toBe(ws1); // reconnected
    ws2!.simulateOpen();
    const history = lastSentMessages(ws2!).find(
      (m) => (m as { type: string }).type === 'request-history',
    );
    expect(history).toEqual({ type: 'request-history', fromOffset: 0 }); // offset reset
    await flush();
    expect(allText(instance)).not.toContain('before'); // buffer reset
  });

  it('worker-restarted for a different worker is ignored', () => {
    const bus = makeAppBus();
    _setAppSubscribe(bus.subscribe);
    const instance = getOrCreateTerminal('wr2', 'w');
    MockWebSocket.getLastInstance()!.simulateOpen();
    const before = MockWebSocket.getInstances().length;

    bus.emit({ type: 'worker-restarted', sessionId: 'other', workerId: 'w', activityState: 'idle' });

    expect(instance.getSnapshot().notice).toBeNull();
    expect(MockWebSocket.getInstances().length).toBe(before);
  });

  // Notice auto-dismiss (issue #968). The notice producer is worker-restarted
  // ('Terminal restarted'); its banner must self-clear after a TTL, reset that
  // clock when replaced, and be canceled by manual dismiss and dispose.
  // The store's auto-dismiss delay (DEFAULT_NOTICE_TTL_MS in terminal-store.ts).
  const NOTICE_TTL_MS = 5000;

  function makeRestartedInstance(sessionId: string) {
    const bus = makeAppBus();
    _setAppSubscribe(bus.subscribe);
    const instance = getOrCreateTerminal(sessionId, 'w');
    MockWebSocket.getLastInstance()!.simulateOpen();
    const emitRestart = () =>
      bus.emit({ type: 'worker-restarted', sessionId, workerId: 'w', activityState: 'idle' });
    return { instance, emitRestart };
  }

  /** The pending setTimeout call scheduled for the notice auto-dismiss. */
  function noticeTimeoutCalls(spy: ReturnType<typeof spyOn>) {
    return spy.mock.calls.filter((call: unknown[]) => call[1] === NOTICE_TTL_MS);
  }

  describe('notice auto-dismiss (#968)', () => {
    it('auto-clears the notice after the TTL', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const { instance, emitRestart } = makeRestartedInstance('n1');

      emitRestart();
      expect(instance.getSnapshot().notice).toBe('Terminal restarted');
      expect(_inspect(instance).noticeTimer).not.toBeNull();

      // Deterministically fire the auto-dismiss timer (no real wait).
      const scheduled = noticeTimeoutCalls(setTimeoutSpy);
      expect(scheduled.length).toBe(1);
      (scheduled[0][0] as () => void)();

      expect(instance.getSnapshot().notice).toBeNull();
      expect(_inspect(instance).noticeTimer).toBeNull();
      setTimeoutSpy.mockRestore();
    });

    it('resets the clock when a new notice replaces a pending one', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
      const { instance, emitRestart } = makeRestartedInstance('n2');

      emitRestart();
      const firstTimer = _inspect(instance).noticeTimer;
      expect(firstTimer).not.toBeNull();
      expect(noticeTimeoutCalls(setTimeoutSpy).length).toBe(1);

      emitRestart(); // second notice replaces the first
      // Old timer canceled, a fresh one scheduled (clock reset).
      expect(clearTimeoutSpy).toHaveBeenCalledWith(firstTimer);
      const secondTimer = _inspect(instance).noticeTimer;
      expect(secondTimer).not.toBeNull();
      expect(secondTimer).not.toBe(firstTimer);
      expect(noticeTimeoutCalls(setTimeoutSpy).length).toBe(2);
      expect(instance.getSnapshot().notice).toBe('Terminal restarted');

      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });

    it('cancels the pending auto-dismiss on manual dismiss', () => {
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
      const { instance, emitRestart } = makeRestartedInstance('n3');

      emitRestart();
      const timer = _inspect(instance).noticeTimer;
      expect(timer).not.toBeNull();
      expect(instance.getSnapshot().notice).toBe('Terminal restarted');

      instance.dismissNotice();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      expect(_inspect(instance).noticeTimer).toBeNull();
      expect(instance.getSnapshot().notice).toBeNull();
      clearTimeoutSpy.mockRestore();
    });

    it('cancels the pending auto-dismiss on dispose and does not notify afterward', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
      const { instance, emitRestart } = makeRestartedInstance('n4');

      emitRestart();
      const timer = _inspect(instance).noticeTimer;
      expect(timer).not.toBeNull();
      // Capture the auto-dismiss callback to prove it is inert after dispose.
      const noticeCallback = noticeTimeoutCalls(setTimeoutSpy)[0][0] as () => void;

      let notified = 0;
      instance.subscribe(() => {
        notified += 1;
      });

      instance.dispose();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      expect(_inspect(instance).disposed).toBe(true);

      // Even if the (canceled) timer callback were force-invoked, it must not
      // patch a disposed instance nor notify listeners.
      notified = 0;
      noticeCallback();
      expect(notified).toBe(0);

      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });
  });

  it('session-deleted (app-WS) disposes the instance', () => {
    const bus = makeAppBus();
    _setAppSubscribe(bus.subscribe);
    const instance = getOrCreateTerminal('sd', 'w');
    MockWebSocket.getLastInstance()!.simulateOpen();

    bus.emit({ type: 'session-deleted', sessionId: 'sd' });

    expect(_inspect(instance).disposed).toBe(true);
    // getOrCreate returns a fresh instance after disposal.
    expect(getOrCreateTerminal('sd', 'w')).not.toBe(instance);
  });

  it('activity message is surfaced in the snapshot', () => {
    const instance = getOrCreateTerminal('act', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'activity', state: 'asking' }));

    expect(instance.getSnapshot().activityState).toBe('asking');
  });

  it('SESSION_PAUSED error prevents reconnect after the subsequent close', () => {
    const instance = getOrCreateTerminal('pause', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(
      JSON.stringify({ type: 'error', message: 'Session paused', code: 'SESSION_PAUSED' }),
    );
    expect(instance.getSnapshot().workerError).toEqual({
      message: 'Session paused',
      code: 'SESSION_PAUSED',
    });

    ws!.simulateClose(); // reconnectable code, but noReconnect is set
    expect(_inspect(instance).reconnectPending).toBe(false);
    expect(_inspect(instance).reconnectAttempts).toBe(0);
  });

  it('records a history load duration for cold-start instrumentation', async () => {
    const instance = getOrCreateTerminal('perf', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'history', data: 'hello', offset: 5 }));
    await flush();

    expect(_inspect(instance).lastHistoryLoadMs).not.toBeNull();
    expect(_inspect(instance).lastHistoryLoadMs).toBeGreaterThanOrEqual(0);
    expect(instance.getSnapshot().loadingHistory).toBe(false);
  });

  // --- PR-1: memory management ---

  it('acquire/release refcount is idempotent under double release', () => {
    const instance = getOrCreateTerminal('mm1', 'w');
    const release1 = instance.acquire();
    const release2 = instance.acquire();
    expect(_inspect(instance).refCount).toBe(2);

    release1();
    release1(); // idempotent: no double decrement
    expect(_inspect(instance).refCount).toBe(1);

    release2();
    expect(_inspect(instance).refCount).toBe(0);
  });

  it('disposes after the idle TTL once refCount reaches 0', async () => {
    _setTimings({ idleTtlMs: 10 });
    const instance = getOrCreateTerminal('mm2', 'w');
    const release = instance.acquire();
    release();
    expect(_inspect(instance).disposed).toBe(false);

    await new Promise((r) => setTimeout(r, 30));
    expect(_inspect(instance).disposed).toBe(true);
  });

  it('uses the shorter exited TTL for exited instances', async () => {
    _setTimings({ idleTtlMs: 100000, exitedTtlMs: 10 });
    const instance = getOrCreateTerminal('mm3', 'w');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();
    ws!.simulateMessage(JSON.stringify({ type: 'exit', exitCode: 0, signal: null }));

    const release = instance.acquire();
    release(); // starts timer with exitedTtlMs (10ms), not idleTtlMs
    await new Promise((r) => setTimeout(r, 30));
    expect(_inspect(instance).disposed).toBe(true);
  });

  it('remount cancels a pending idle disposal', async () => {
    _setTimings({ idleTtlMs: 20 });
    const instance = getOrCreateTerminal('mm4', 'w');
    const release = instance.acquire();
    release(); // idle timer armed
    instance.acquire(); // remount cancels it
    await new Promise((r) => setTimeout(r, 40));
    expect(_inspect(instance).disposed).toBe(false);
  });

  it('LRU-evicts the least-recently-released idle instance over the cap', async () => {
    _setTimings({ maxInstances: 2 });
    const a = getOrCreateTerminal('lru-a', 'w');
    a.acquire()(); // refCount 0, released first
    await new Promise((r) => setTimeout(r, 2));
    const b = getOrCreateTerminal('lru-b', 'w');
    b.acquire()(); // refCount 0, released later
    await new Promise((r) => setTimeout(r, 2));

    // Creating a third instance over the cap evicts the oldest idle one (a).
    const c = getOrCreateTerminal('lru-c', 'w');
    expect(_inspect(a).disposed).toBe(true);
    expect(_inspect(b).disposed).toBe(false);
    expect(_inspect(c).disposed).toBe(false);
  });

  it('never evicts an instance with refCount > 0', () => {
    _setTimings({ maxInstances: 2 });
    const a = getOrCreateTerminal('busy-a', 'w');
    a.acquire(); // refCount 1 -> pinned
    const b = getOrCreateTerminal('busy-b', 'w');
    b.acquire()(); // idle

    // c over the cap: a is pinned, so b (the only idle one) is evicted.
    getOrCreateTerminal('busy-c', 'w');
    expect(_inspect(a).disposed).toBe(false);
    expect(_inspect(b).disposed).toBe(true);
  });
});
