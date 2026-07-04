import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { AppServerMessage } from '@agent-console/shared';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { getOrCreateTerminal, _resetTerminals, _setAppSubscribe, _inspect } from '../terminal-store';

/** Capturable app-WS subscribe seam (worker-restarted emission). */
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

function flush(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sentMessages(ws: MockWebSocket): Array<{ type: string; [k: string]: unknown }> {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0]));
}
function lastOfType(ws: MockWebSocket, type: string): { [k: string]: unknown } | undefined {
  return [...sentMessages(ws)].reverse().find((m) => m.type === type);
}
function countOfType(ws: MockWebSocket, type: string): number {
  return sentMessages(ws).filter((m) => m.type === type).length;
}
function allText(instance: ReturnType<typeof getOrCreateTerminal>): string {
  return instance
    .getSnapshot()
    .rows.map((r) => r.segments.map((s) => s.text).join(''))
    .join('\n');
}

function open(sessionId: string, workerId: string) {
  const instance = getOrCreateTerminal(sessionId, workerId);
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('no ws');
  ws.simulateOpen();
  return { instance, ws };
}

interface HistoryOpts {
  data?: string;
  offset?: number;
  startOffset?: number;
  epoch?: number;
}
async function seedHistory(ws: MockWebSocket, opts: HistoryOpts = {}) {
  const { data = 'hello\r\n', offset = 100, startOffset = 50, epoch = 1000 } = opts;
  ws.simulateMessage(JSON.stringify({ type: 'history', data, offset, startOffset, epoch }));
  await flush();
}

interface RangeResp {
  data: string;
  startOffset: number;
  endOffset: number;
  hasMore: boolean;
  epoch: number;
}
async function pageChunk(
  ws: MockWebSocket,
  instance: ReturnType<typeof getOrCreateTerminal>,
  resp: RangeResp,
) {
  instance.requestOlderHistory();
  const req = lastOfType(ws, 'request-history-range');
  ws.simulateMessage(JSON.stringify({ type: 'history-range', requestId: req?.requestId, ...resp }));
  await flush();
}

describe('terminal-store paging', () => {
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
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it('seeds oldestOffset/epoch from the initial history and enables paging', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50, offset: 100, epoch: 1000 });
    const p = _inspect(instance).paging;
    expect(p.oldestOffset).toBe(50);
    expect(p.liveStartOffset).toBe(50);
    expect(p.epoch).toBe(1000);
    expect(p.hasMoreHistory).toBe(true);
    expect(instance.getSnapshot().canRequestOlder).toBe(true);
  });

  it('requestOlderHistory sends a correlated range request and guards re-entry', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });

    instance.requestOlderHistory();
    const req = lastOfType(ws, 'request-history-range');
    expect(req).toMatchObject({ type: 'request-history-range', beforeOffset: 50, maxBytes: 262144 });
    expect(typeof req?.requestId).toBe('number');
    expect(_inspect(instance).paging.loadingOlder).toBe(true);

    // In-flight guard: a second call issues no new request.
    instance.requestOlderHistory();
    expect(countOfType(ws, 'request-history-range')).toBe(1);
  });

  it('prepends a replayed chunk, chains the cursor, and stops at hasMore=false', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });

    await pageChunk(ws, instance, {
      data: 'older content\r\n',
      startOffset: 10,
      endOffset: 50,
      hasMore: true,
      epoch: 1000,
    });
    let p = _inspect(instance).paging;
    expect(p.oldestOffset).toBe(10);
    expect(p.pagedChunkCount).toBe(1);
    expect(p.pagedRowCount).toBeGreaterThan(0);
    expect(p.loadingOlder).toBe(false);
    expect(allText(instance)).toContain('older content');
    // Paged rows carry negative keys distinct from live rows.
    expect(instance.getSnapshot().rows[0].key).toBeLessThan(0);

    // Next page reaches the stream start.
    const before = lastOfType(ws, 'request-history-range');
    void before;
    await pageChunk(ws, instance, {
      data: 'first bytes\r\n',
      startOffset: 0,
      endOffset: 10,
      hasMore: false,
      epoch: 1000,
    });
    p = _inspect(instance).paging;
    expect(p.oldestOffset).toBe(0);
    expect(p.hasMoreHistory).toBe(false);
    expect(instance.getSnapshot().canRequestOlder).toBe(false);
  });

  it('discards a non-contiguous response but clears the correlated loading flag', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    instance.requestOlderHistory();
    const req = lastOfType(ws, 'request-history-range');

    // endOffset (40) does not abut the window top (50) -> discard, no prepend.
    ws.simulateMessage(
      JSON.stringify({
        type: 'history-range',
        requestId: req?.requestId,
        data: 'x\r\n',
        startOffset: 30,
        endOffset: 40,
        hasMore: true,
        epoch: 1000,
      }),
    );
    await flush();
    const p = _inspect(instance).paging;
    expect(p.pagedChunkCount).toBe(0);
    expect(p.oldestOffset).toBe(50);
    expect(p.loadingOlder).toBe(false);
  });

  it('discards a stale requestId without touching in-flight state', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    instance.requestOlderHistory();

    ws.simulateMessage(
      JSON.stringify({
        type: 'history-range',
        requestId: 9999,
        data: 'x\r\n',
        startOffset: 10,
        endOffset: 50,
        hasMore: true,
        epoch: 1000,
      }),
    );
    await flush();
    const p = _inspect(instance).paging;
    expect(p.pagedChunkCount).toBe(0);
    expect(p.loadingOlder).toBe(true); // still awaiting the real response
    expect(p.rangeRequestId).not.toBeNull();
  });

  it('treats an unavailable (empty) range as end-of-history', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    await pageChunk(ws, instance, {
      data: '',
      startOffset: 50,
      endOffset: 50,
      hasMore: false,
      epoch: 1000,
    });
    const p = _inspect(instance).paging;
    expect(p.hasMoreHistory).toBe(false);
    expect(p.pagedChunkCount).toBe(0);
    expect(instance.getSnapshot().canRequestOlder).toBe(false);
  });

  it('re-requests at a quartered maxBytes when the replay overflows', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    // A newline-heavy chunk overflows the throwaway 100k scrollback.
    await pageChunk(ws, instance, {
      data: '\n'.repeat(100_001),
      startOffset: 10,
      endOffset: 50,
      hasMore: true,
      epoch: 1000,
    });
    await flush(120);
    const req = lastOfType(ws, 'request-history-range');
    expect(req).toMatchObject({ beforeOffset: 50, maxBytes: 65536 });
    // Truncated replay is never committed.
    expect(_inspect(instance).paging.pagedChunkCount).toBe(0);
  });

  it('marks paging unsupported when no range response arrives before the timeout', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const captured: { rangeCb: (() => void) | null } = { rangeCb: null };
    const spy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((...args: Parameters<typeof setTimeout>) => {
        const [cb, delay] = args;
        if (delay === 5000) {
          captured.rangeCb = cb as () => void;
          // A real (never-firing) handle so the store can clearTimeout it; the
          // range callback is invoked manually below.
          return realSetTimeout(() => {}, 1_000_000);
        }
        return realSetTimeout(...args);
      }) as typeof setTimeout,
    );
    try {
      const { instance, ws } = open('s', 'w');
      await seedHistory(ws, { startOffset: 50 });
      instance.requestOlderHistory();
      expect(captured.rangeCb).not.toBeNull();
      captured.rangeCb?.();
      let p = _inspect(instance).paging;
      expect(p.pagingUnsupported).toBe(true);
      expect(p.loadingOlder).toBe(false);
      expect(instance.getSnapshot().canRequestOlder).toBe(false);

      // A reconnect re-probes: pagingUnsupported clears on the fresh connection.
      instance.retry();
      p = _inspect(instance).paging;
      expect(p.pagingUnsupported).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('clears the correlated loadingOlder on a range error carrying its requestId', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    instance.requestOlderHistory();
    const req = lastOfType(ws, 'request-history-range');

    ws.simulateMessage(
      JSON.stringify({
        type: 'error',
        message: 'range failed',
        code: 'HISTORY_LOAD_FAILED',
        requestId: req?.requestId,
      }),
    );
    await flush();
    const p = _inspect(instance).paging;
    expect(p.loadingOlder).toBe(false);
    expect(p.rangeRequestId).toBeNull();
    // A range error must NOT surface as a worker error.
    expect(instance.getSnapshot().workerError).toBeNull();
  });

  it('resyncs on an epoch mismatch: discards, queues live output, replays after fresh history', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { data: 'gen1\r\n', offset: 100, startOffset: 50, epoch: 1000 });

    // A new-incarnation output (epoch 2000) must not be applied as-is.
    ws.simulateMessage(JSON.stringify({ type: 'output', data: 'STALE', offset: 110, epoch: 2000 }));
    await flush();
    let p = _inspect(instance).paging;
    expect(p.epoch).toBe(2000);
    expect(p.resyncing).toBe(true);
    // A fresh initial history request was issued (fromOffset 0).
    expect(lastOfType(ws, 'request-history')).toMatchObject({ fromOffset: 0 });

    // Live output during the resync is queued, not applied.
    ws.simulateMessage(JSON.stringify({ type: 'output', data: 'later\r\n', offset: 120, epoch: 2000 }));
    await flush();
    expect(_inspect(instance).paging.queuedOutputCount).toBe(1);

    // The fresh history lands; the queue replays, dropping covered entries.
    ws.simulateMessage(
      JSON.stringify({ type: 'history', data: 'gen2\r\n', offset: 115, startOffset: 0, epoch: 2000 }),
    );
    await flush();
    p = _inspect(instance).paging;
    expect(p.resyncing).toBe(false);
    expect(p.queuedOutputCount).toBe(0);
    const text = allText(instance);
    expect(text).toContain('gen2');
    expect(text).toContain('later');
    expect(text).not.toContain('STALE');
  });

  it('drops paged state and epoch on worker restart', async () => {
    const bus = makeAppBus();
    _setAppSubscribe(bus.subscribe);
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    await pageChunk(ws, instance, {
      data: 'archived\r\n',
      startOffset: 10,
      endOffset: 50,
      hasMore: true,
      epoch: 1000,
    });
    expect(_inspect(instance).paging.pagedChunkCount).toBe(1);

    bus.emit({ type: 'worker-restarted', sessionId: 's', workerId: 'w' } as AppServerMessage);
    const p = _inspect(instance).paging;
    expect(p.pagedChunkCount).toBe(0);
    expect(p.epoch).toBeNull();
    expect(p.oldestOffset).toBe(0);
  });

  it('drops paged chunks on a cols resize and restores the cursor to the live window', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    await pageChunk(ws, instance, {
      data: 'archived\r\n',
      startOffset: 10,
      endOffset: 50,
      hasMore: true,
      epoch: 1000,
    });
    expect(_inspect(instance).paging.oldestOffset).toBe(10);

    instance.resize(100, 24); // cols change 80 -> 100
    const p = _inspect(instance).paging;
    expect(p.pagedChunkCount).toBe(0);
    expect(p.oldestOffset).toBe(50); // back to liveStartOffset
    expect(p.hasMoreHistory).toBe(true);
  });

  it('evicts the oldest chunk and re-enables fetch', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    await pageChunk(ws, instance, {
      data: 'chunk-a\r\n',
      startOffset: 30,
      endOffset: 50,
      hasMore: true,
      epoch: 1000,
    });
    await pageChunk(ws, instance, {
      data: 'chunk-b\r\n',
      startOffset: 10,
      endOffset: 30,
      hasMore: true,
      epoch: 1000,
    });
    expect(_inspect(instance).paging.pagedChunkCount).toBe(2);

    instance.evictTopChunk();
    const p = _inspect(instance).paging;
    expect(p.pagedChunkCount).toBe(1);
    expect(p.oldestOffset).toBe(30); // raised to the evicted chunk's end
    expect(p.hasMoreHistory).toBe(true);
    expect(p.pagedCapReached).toBe(false);
  });

  it('refuses further fetch once the paged-row cap is reached', async () => {
    const { instance, ws } = open('s', 'w');
    await seedHistory(ws, { startOffset: 50 });
    // 15000 non-blank rows hits MAX_PAGED_ROWS in one chunk.
    await pageChunk(ws, instance, {
      data: 'a\n'.repeat(15000),
      startOffset: 10,
      endOffset: 50,
      hasMore: true,
      epoch: 1000,
    });
    await flush(200);
    const p = _inspect(instance).paging;
    expect(p.pagedRowCount).toBeGreaterThanOrEqual(15000);
    expect(p.pagedCapReached).toBe(true);
    expect(instance.getSnapshot().canRequestOlder).toBe(false);
    expect(instance.getSnapshot().pagedCapReached).toBe(true);

    // The cap makes requestOlderHistory inert.
    const before = countOfType(ws, 'request-history-range');
    instance.requestOlderHistory();
    expect(countOfType(ws, 'request-history-range')).toBe(before);
  });
});
