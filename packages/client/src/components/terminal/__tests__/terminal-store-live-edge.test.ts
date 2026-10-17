import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { getOrCreateTerminal, _resetTerminals, _inspect, _whenIdle, _setLiveEdgePieceBytesForTest } from '../terminal-store';

// Live-edge accounting (terminal-history-paging.md section 6.5): frame markers tell the
// store which bytes the live buffer has evicted, and the paging cursor follows.

const EPOCH = 1000;

function flush(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function open() {
  const instance = getOrCreateTerminal('s-live-edge', 'w-live-edge');
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('no ws');
  ws.simulateOpen();
  return { instance, ws };
}

function history(ws: MockWebSocket, opts: { data?: string; offset: number; startOffset: number }) {
  ws.simulateMessage(JSON.stringify({ type: 'history', data: opts.data ?? '', offset: opts.offset, startOffset: opts.startOffset, epoch: EPOCH }));
}

/** Stream `frames` frames of `lines` lines each; offsets advance by the data length. */
async function stream(ws: MockWebSocket, from: number, frames: number, lines: number): Promise<number> {
  let offset = from;
  for (let f = 0; f < frames; f++) {
    const data = Array.from({ length: lines }, (_, i) => `frame ${f} line ${i}`).join('\r\n') + '\r\n';
    offset += data.length;
    ws.simulateMessage(JSON.stringify({ type: 'output', data, offset, epoch: EPOCH }));
  }
  await _whenIdle();
  return offset;
}

function rangeRequests(ws: MockWebSocket): Array<{ beforeOffset: number }> {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0])).filter((m) => m.type === 'request-history-range');
}

describe('terminal-store live-edge accounting', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    _resetTerminals();
    restoreWebSocket = installMockWebSocket();
  });

  afterEach(() => {
    _setLiveEdgePieceBytesForTest(null);
    _resetTerminals();
    restoreWebSocket();
  });

  it('no eviction: liveEvictedUpTo stays 0 and the cursor stays at the attach start', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 1000, startOffset: 400 });
    await stream(ws, 1000, 5, 10);
    const p = _inspect(instance).paging;
    expect(p.liveEvictedUpTo).toBe(0);
    expect(p.oldestOffset).toBe(400);
    expect(p.liveStartOffset).toBe(400);
  });

  it('eviction advances liveEvictedUpTo to a frame end and moves the paging cursor with it', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 1000, startOffset: 400 });
    // 300 frames x 30 lines = 9000 rows > SCROLLBACK 5000.
    const end = await stream(ws, 1000, 300, 30);
    const p = _inspect(instance).paging;
    expect(p.liveEvictedUpTo).toBeGreaterThan(1000);
    expect(p.liveEvictedUpTo).toBeLessThan(end);
    expect(p.oldestOffset).toBe(p.liveEvictedUpTo);
    expect(p.liveStartOffset).toBe(400);
    instance.requestOlderHistory();
    expect(rangeRequests(ws).at(-1)?.beforeOffset).toBe(p.liveEvictedUpTo);
  });

  it('attach at offset 0: no fetch is sent until eviction, then the first fetch is', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 0, startOffset: 0 });
    await flush();
    expect(_inspect(instance).paging.oldestOffset).toBe(0);
    instance.requestOlderHistory();
    expect(rangeRequests(ws)).toHaveLength(0);

    await stream(ws, 0, 300, 30);
    const p = _inspect(instance).paging;
    expect(p.liveStartOffset).toBe(0);
    expect(p.liveEvictedUpTo).toBeGreaterThan(0);
    expect(p.hasMoreHistory).toBe(true);
    instance.requestOlderHistory();
    expect(rangeRequests(ws)).toHaveLength(1);
    expect(rangeRequests(ws)[0].beforeOffset).toBe(p.liveEvictedUpTo);
  });

  it('the marker deque stays bounded at 512 entries', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 0, startOffset: 0 });
    await stream(ws, 0, 700, 1);
    const p = _inspect(instance).paging;
    expect(p.frameMarkerCount).toBe(512);
    // Every marker the deque gave up was disposed in xterm too: no leak past the cap.
    expect(p.liveMarkerCount).toBe(p.frameMarkerCount);
    expect(p.liveEvictedUpTo).toBe(0);
    // The oldest entry keeps its own end offset (the second-oldest boundary was given up).
    expect(p.frameMarkerEndOffsets[0]).toBeLessThan(p.frameMarkerEndOffsets[1]);
  });

  it('a large frame is written in line-aligned pieces, one marker per piece, ending exactly at the frame end', async () => {
    _setLiveEdgePieceBytesForTest(200);
    const { instance, ws } = open();
    history(ws, { offset: 0, startOffset: 0 });
    const line = '0123456789'.repeat(4) + '\r\n'; // 42 bytes
    const data = line.repeat(100); // 4200 bytes, 21 pieces of ~5 lines
    ws.simulateMessage(JSON.stringify({ type: 'output', data, offset: data.length, epoch: EPOCH }));
    await _whenIdle();
    const ends = _inspect(instance).paging.frameMarkerEndOffsets;
    expect(ends.length).toBeGreaterThan(15);
    expect(ends.at(-1)).toBe(data.length);
    expect(ends.every((e, i) => i === 0 || e > ends[i - 1])).toBe(true);
    expect(ends.every((e) => e % 42 === 0)).toBe(true); // line-aligned
  });

  it('piece end offsets are byte-exact for multi-byte text', async () => {
    _setLiveEdgePieceBytesForTest(100);
    const { instance, ws } = open();
    history(ws, { offset: 0, startOffset: 0 });
    const line = '\u3042'.repeat(10) + '\r\n'; // 10 x 3 bytes + 2 = 32 bytes
    const data = line.repeat(50);
    const bytes = new TextEncoder().encode(data).length;
    ws.simulateMessage(JSON.stringify({ type: 'output', data, offset: bytes, epoch: EPOCH }));
    await _whenIdle();
    const ends = _inspect(instance).paging.frameMarkerEndOffsets;
    expect(ends.length).toBeGreaterThan(5);
    expect(ends.at(-1)).toBe(bytes);
    expect(ends.every((e) => e % 32 === 0)).toBe(true);
  });

  // Alt-screen: measured on @xterm/headless 5.5, entering the alternate buffer neither
  // disposes the normal buffer's markers nor accepts new ones (registerMarker returns
  // undefined there), so frames written on the alt screen register none. The disposal
  // predicate is isScrollbackEviction: normal buffer AND length >= rows + SCROLLBACK.
  it('alt-screen enter/exit does not advance liveEvictedUpTo or move the paging cursor', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 1000, startOffset: 400 });
    let offset = await stream(ws, 1000, 5, 10);
    const before = _inspect(instance).paging;
    const markersBefore = before.frameMarkerCount;
    const alt = '\x1b[?1049h' + Array.from({ length: 30 }, (_, i) => `alt ${i}`).join('\r\n') + '\x1b[?1049l';
    offset += alt.length;
    ws.simulateMessage(JSON.stringify({ type: 'output', data: alt, offset, epoch: EPOCH }));
    await _whenIdle();
    const after = _inspect(instance).paging;
    expect(after.liveEvictedUpTo).toBe(0);
    expect(after.oldestOffset).toBe(400);
    expect(after.frameMarkerCount).toBeGreaterThanOrEqual(markersBefore);
    instance.requestOlderHistory();
    expect(rangeRequests(ws).at(-1)?.beforeOffset).toBe(400);
  });

  it('alt-screen after a real eviction keeps the eviction cursor', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 1000, startOffset: 400 });
    let offset = await stream(ws, 1000, 300, 30);
    const evicted = _inspect(instance).paging.liveEvictedUpTo;
    expect(evicted).toBeGreaterThan(1000);
    const alt = '\x1b[?1049hhello\x1b[?1049l';
    offset += alt.length;
    ws.simulateMessage(JSON.stringify({ type: 'output', data: alt, offset, epoch: EPOCH }));
    await _whenIdle();
    expect(_inspect(instance).paging.liveEvictedUpTo).toBeGreaterThanOrEqual(evicted);
    expect(_inspect(instance).paging.oldestOffset).toBe(_inspect(instance).paging.liveEvictedUpTo);
  });

  it('liveEvictedUpTo and the markers reset on an epoch change', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 1000, startOffset: 400 });
    await stream(ws, 1000, 300, 30);
    expect(_inspect(instance).paging.liveEvictedUpTo).toBeGreaterThan(0);
    ws.simulateMessage(JSON.stringify({ type: 'output', data: 'x\r\n', offset: 5, epoch: EPOCH + 1 }));
    await _whenIdle();
    const p = _inspect(instance).paging;
    expect(p.liveEvictedUpTo).toBe(0);
    expect(p.frameMarkerCount).toBe(0);
  });

  it('disposing the store releases the markers', async () => {
    const { instance, ws } = open();
    history(ws, { offset: 1000, startOffset: 400 });
    await stream(ws, 1000, 5, 10);
    expect(_inspect(instance).paging.frameMarkerCount).toBeGreaterThan(0);
    instance.dispose();
    expect(_inspect(instance).paging.frameMarkerCount).toBe(0);
  });
});
