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

const SID = 'session-1';
const WID = 'w-1';

function makeWs(): { ws: WSContext; sent: WorkerServerMessage[] } {
  const sent: WorkerServerMessage[] = [];
  const ws = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as WorkerServerMessage);
    },
  } as unknown as WSContext;
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
