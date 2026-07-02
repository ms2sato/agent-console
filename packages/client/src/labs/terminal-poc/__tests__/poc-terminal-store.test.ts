import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { getOrCreatePocTerminal, _resetPocTerminals } from '../poc-terminal-store';

/** Let write callbacks + the rAF/timeout snapshot flush run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

function lastSentMessages(ws: MockWebSocket): unknown[] {
  const calls = ws.send.mock.calls as unknown as string[][];
  return calls.map((call) => JSON.parse(call[0]));
}

function allText(instance: ReturnType<typeof getOrCreatePocTerminal>): string {
  return instance
    .getSnapshot()
    .rows.map((r) => r.segments.map((s) => s.text).join(''))
    .join('\n');
}

describe('poc-terminal-store', () => {
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
    _resetPocTerminals();
    restoreWebSocket();
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  it('requests full history with fromOffset 0 on open', () => {
    getOrCreatePocTerminal('s1', 'w1');
    const ws = MockWebSocket.getLastInstance();
    expect(ws).toBeDefined();
    ws!.simulateOpen();

    const sent = lastSentMessages(ws!);
    const history = sent.find((m) => (m as { type: string }).type === 'request-history');
    expect(history).toEqual({ type: 'request-history', fromOffset: 0 });
  });

  it('sends initial resize on open', () => {
    getOrCreatePocTerminal('s2', 'w2');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const sent = lastSentMessages(ws!);
    const resize = sent.find((m) => (m as { type: string }).type === 'resize');
    expect(resize).toMatchObject({ type: 'resize' });
  });

  it('renders output into snapshot rows and bumps version', async () => {
    const instance = getOrCreatePocTerminal('s3', 'w3');
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
    const instance = getOrCreatePocTerminal('s4', 'w4');
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
    const instance = getOrCreatePocTerminal('s3j', 'w3j');
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
    const instance = getOrCreatePocTerminal('s2j', 'w2j');
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

  it('strips [internal:...] system lines from rendered output', async () => {
    const instance = getOrCreatePocTerminal('sint', 'wint');
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

  it('sendInput sends a correct input frame', () => {
    const instance = getOrCreatePocTerminal('s5', 'w5');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    instance.sendInput('ls\r');
    const sent = lastSentMessages(ws!);
    expect(sent).toContainEqual({ type: 'input', data: 'ls\r' });
  });

  it('sets status to exited on exit message', () => {
    const instance = getOrCreatePocTerminal('s6', 'w6');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(JSON.stringify({ type: 'exit', exitCode: 0, signal: null }));
    const snap = instance.getSnapshot();
    expect(snap.status).toBe('exited');
    expect(snap.exitInfo).toEqual({ code: 0, signal: null });
  });

  it('keeps status exited and does not reconnect when the socket closes after exit', () => {
    const instance = getOrCreatePocTerminal('s6b', 'w6b');
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
    const instance = getOrCreatePocTerminal('s6c', 'w6c');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateClose();
    expect(instance.getSnapshot().status).toBe('disconnected');
  });

  it('reuses the same instance for the same session/worker key', () => {
    const a = getOrCreatePocTerminal('s7', 'w7');
    const b = getOrCreatePocTerminal('s7', 'w7');
    expect(a).toBe(b);
  });

  it('interface methods survive being destructured (useSyncExternalStore contract)', () => {
    const instance = getOrCreatePocTerminal('s8', 'w8');
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
});
