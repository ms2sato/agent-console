import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { getOrCreateTerminal, _resetTerminals, _inspect, _whenIdle } from '../terminal-store';

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
    expect(_inspect(instance).paging.frameMarkerCount).toBe(512);
    expect(_inspect(instance).paging.liveEvictedUpTo).toBe(0);
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
