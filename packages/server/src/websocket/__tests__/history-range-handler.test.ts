/**
 * Tests for the worker-WS `request-history-range` handler
 * (terminal-history-paging.md §5.1): requestId correlation, boundary validation
 * of client numeric input, the unavailable-range fallback shape, success
 * pass-through, and the timeout / error → HISTORY_LOAD_FAILED path.
 */
import { describe, it, expect } from 'bun:test';
import type { WSContext } from 'hono/ws';
import type { WorkerServerMessage } from '@agent-console/shared';
import type { HistoryRangeResult } from '../../lib/worker-output-file.js';
import {
  handleHistoryRangeRequest,
  type HistoryRangeSessionManager,
} from '../history-range-handler.js';
import { HistoryInFlightLimiter } from '../history-in-flight-limiter.js';
import { asWSContext } from './ws-test-helpers.js';

const SID = 'session-1';
const WID = 'w-1';

function makeWs(): { ws: WSContext; sent: WorkerServerMessage[] } {
  const sent: WorkerServerMessage[] = [];
  const ws = asWSContext({
    send: (data: string) => {
      sent.push(JSON.parse(data) as WorkerServerMessage);
    },
  });
  return { ws, sent };
}

function makeManager(overrides: Partial<HistoryRangeSessionManager>): HistoryRangeSessionManager {
  return {
    getWorkerHistoryRange: async () => null,
    getWorkerEpoch: () => 42,
    ...overrides,
  };
}

const RESULT: HistoryRangeResult = {
  data: 'archived bytes',
  startOffset: 100,
  endOffset: 200,
  hasMore: true,
  epoch: 777,
};

describe('handleHistoryRangeRequest', () => {
  it('echoes requestId and passes the served range through on success', async () => {
    const { ws, sent } = makeWs();
    const manager = makeManager({ getWorkerHistoryRange: async () => RESULT });

    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId: 7, beforeOffset: 200, maxBytes: 256 }, manager);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'history-range',
      requestId: 7,
      data: 'archived bytes',
      startOffset: 100,
      endOffset: 200,
      hasMore: true,
      epoch: 777,
    });
  });

  it('forwards a maxBytes of 0 to the manager (the manager, not the handler, handles it)', async () => {
    const { ws } = makeWs();
    const calls: Array<{ beforeOffset: number; maxBytes?: number }> = [];
    const manager = makeManager({
      getWorkerHistoryRange: async (_s, _w, beforeOffset, maxBytes) => {
        calls.push({ beforeOffset, maxBytes });
        return RESULT;
      },
    });

    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId: 1, beforeOffset: 50, maxBytes: 0 }, manager);
    expect(calls[0]).toEqual({ beforeOffset: 50, maxBytes: 0 });
  });

  it('returns the unavailable shape (echoing requestId) when the manager returns null', async () => {
    const { ws, sent } = makeWs();
    const manager = makeManager({ getWorkerHistoryRange: async () => null, getWorkerEpoch: () => 9 });

    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId: 3, beforeOffset: 500 }, manager);

    expect(sent).toEqual([
      { type: 'history-range', requestId: 3, data: '', startOffset: 500, endOffset: 500, hasMore: false, epoch: 9 },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['negative', -1],
    ['non-integer', 1.5],
    ['NaN', Number.NaN],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('drops the message (no response) when requestId is %s', async (_label, requestId) => {
    const { ws, sent } = makeWs();
    const manager = makeManager({});
    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId, beforeOffset: 10 }, manager);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['negative', -5],
    ['NaN', Number.NaN],
    ['non-integer', 3.14],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('answers an invalid beforeOffset (%s) with the unavailable shape anchored at 0', async (_label, beforeOffset) => {
    const { ws, sent } = makeWs();
    const manager = makeManager({ getWorkerEpoch: () => 5 });

    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId: 8, beforeOffset }, manager);

    expect(sent).toEqual([
      { type: 'history-range', requestId: 8, data: '', startOffset: 0, endOffset: 0, hasMore: false, epoch: 5 },
    ]);
  });

  it('answers an invalid maxBytes with the unavailable shape (does not call the manager)', async () => {
    const { ws, sent } = makeWs();
    let called = false;
    const manager = makeManager({
      getWorkerHistoryRange: async () => {
        called = true;
        return RESULT;
      },
    });

    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId: 2, beforeOffset: 10, maxBytes: -1 }, manager);

    expect(called).toBe(false);
    expect(sent[0].type).toBe('history-range');
    expect((sent[0] as Extract<WorkerServerMessage, { type: 'history-range' }>).data).toBe('');
  });

  it('answers a read error with HISTORY_LOAD_FAILED carrying the same requestId', async () => {
    const { ws, sent } = makeWs();
    const manager = makeManager({
      getWorkerHistoryRange: async () => {
        throw new Error('disk exploded');
      },
    });

    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId: 11, beforeOffset: 200 }, manager);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'error',
      code: 'HISTORY_LOAD_FAILED',
      message: expect.any(String),
      requestId: 11,
    });
  });

  it('answers a timeout with HISTORY_LOAD_FAILED carrying the same requestId', async () => {
    const { ws, sent } = makeWs();
    const manager = makeManager({
      getWorkerHistoryRange: () => new Promise<HistoryRangeResult | null>(() => {}), // never resolves
    });

    await handleHistoryRangeRequest(
      ws,
      SID,
      WID,
      { type: 'request-history-range', requestId: 99, beforeOffset: 200 },
      manager,
      { timeoutMs: 20 },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'error',
      code: 'HISTORY_LOAD_FAILED',
      message: expect.any(String),
      requestId: 99,
    });
  });
});

describe('handleHistoryRangeRequest with a per-connection limiter', () => {
  const REQ = { type: 'request-history-range', requestId: 5, beforeOffset: 200 };

  it('answers over-cap with HISTORY_LOAD_FAILED echoing requestId, without calling the manager', async () => {
    const { ws, sent } = makeWs();
    const limiter = new HistoryInFlightLimiter(1);
    limiter.tryAcquire(); // the cap is already full
    let called = false;
    const manager = makeManager({
      getWorkerHistoryRange: async () => {
        called = true;
        return RESULT;
      },
    });

    await handleHistoryRangeRequest(ws, SID, WID, REQ, manager, { limiter });

    expect(called).toBe(false);
    expect(sent).toEqual([
      {
        type: 'error',
        code: 'HISTORY_LOAD_FAILED',
        message: 'Too many concurrent history requests on this connection (max 1); retry after the pending ones complete.',
        requestId: 5,
      },
    ]);
    // Never the unavailable shape.
    expect(sent.some((m) => m.type === 'history-range')).toBe(false);
    // A refused request does not take or give back a slot.
    expect(limiter.inFlight).toBe(1);
  });

  it('holds a slot while the read is pending and releases it on success', async () => {
    const { ws } = makeWs();
    const limiter = new HistoryInFlightLimiter(2);
    let resolveRead: (r: HistoryRangeResult) => void = () => {};
    const manager = makeManager({
      getWorkerHistoryRange: () => new Promise<HistoryRangeResult | null>((resolve) => { resolveRead = resolve; }),
    });

    const pending = handleHistoryRangeRequest(ws, SID, WID, REQ, manager, { limiter });
    expect(limiter.inFlight).toBe(1);
    resolveRead(RESULT);
    await pending;
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot on a read error, a null result and an invalid-input fallback', async () => {
    const cases: Array<[string, Partial<HistoryRangeSessionManager>, Record<string, unknown>]> = [
      ['read error', { getWorkerHistoryRange: async () => { throw new Error('disk'); } }, REQ],
      ['null result', { getWorkerHistoryRange: async () => null }, REQ],
      ['invalid beforeOffset', {}, { ...REQ, beforeOffset: -1 }],
    ];
    for (const [label, overrides, request] of cases) {
      const { ws } = makeWs();
      const limiter = new HistoryInFlightLimiter(1);
      await handleHistoryRangeRequest(ws, SID, WID, request, makeManager(overrides), { limiter, timeoutMs: 20 });
      // Let the read's own settlement handler run before reading the count.
      await Promise.resolve();
      expect([label, limiter.inFlight]).toEqual([label, 0]);
    }
  });

  // The slot belongs to the READ, not to the race. A read that outlives the
  // timeout answers the client at once but keeps its slot until it settles, so
  // at most `max` reads per connection can ever sit in the per-worker lock
  // queue. Measured reach: releasing in the race's own `finally` instead fails
  // this test (the follow-up request is served while the first read is still
  // running).
  it('keeps the slot of a timed-out read until that read settles', async () => {
    const limiter = new HistoryInFlightLimiter(1);
    let settleRead: (r: HistoryRangeResult | null) => void = () => {};
    const slowManager = makeManager({
      getWorkerHistoryRange: () => new Promise<HistoryRangeResult | null>((resolve) => { settleRead = resolve; }),
    });

    const first = makeWs();
    await handleHistoryRangeRequest(first.ws, SID, WID, { ...REQ, requestId: 1 }, slowManager, { limiter, timeoutMs: 20 });
    // The client was told immediately, via the race.
    expect(first.sent).toEqual([
      { type: 'error', code: 'HISTORY_LOAD_FAILED', message: expect.any(String), requestId: 1 },
    ]);
    // ...but the read is still running, so its slot is still taken.
    expect(limiter.inFlight).toBe(1);

    const second = makeWs();
    await handleHistoryRangeRequest(second.ws, SID, WID, { ...REQ, requestId: 2 }, makeManager({ getWorkerHistoryRange: async () => RESULT }), { limiter });
    expect(second.sent).toEqual([
      { type: 'error', code: 'HISTORY_LOAD_FAILED', message: expect.stringContaining('Too many concurrent'), requestId: 2 },
    ]);

    settleRead(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(limiter.inFlight).toBe(0);

    const third = makeWs();
    await handleHistoryRangeRequest(third.ws, SID, WID, { ...REQ, requestId: 3 }, makeManager({ getWorkerHistoryRange: async () => RESULT }), { limiter });
    expect(third.sent).toHaveLength(1);
    expect(third.sent[0].type).toBe('history-range');
  });

  it('releases the slot when the manager throws synchronously', async () => {
    const { ws } = makeWs();
    const limiter = new HistoryInFlightLimiter(1);
    const manager = makeManager({ getWorkerEpoch: () => { throw new Error('epoch lookup failed'); } });
    await expect(handleHistoryRangeRequest(ws, SID, WID, REQ, manager, { limiter })).rejects.toThrow('epoch lookup failed');
    expect(limiter.inFlight).toBe(0);
  });

  it('drops an invalid requestId silently and does not consume a slot, even at cap', async () => {
    const { ws, sent } = makeWs();
    const limiter = new HistoryInFlightLimiter(1);
    limiter.tryAcquire();
    await handleHistoryRangeRequest(ws, SID, WID, { type: 'request-history-range', requestId: 'x', beforeOffset: 1 }, makeManager({}), { limiter });
    expect(sent).toEqual([]);
    expect(limiter.inFlight).toBe(1);
    expect(limiter.rejectedCount).toBe(0);
  });
});
