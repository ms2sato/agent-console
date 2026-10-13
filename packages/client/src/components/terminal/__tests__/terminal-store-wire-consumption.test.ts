/**
 * Wire-consumption fixtures for the PTY terminal store: one real-shaped
 * `WorkerServerMessage` frame per `WorkerServerMessageType`, fed through the
 * REAL entry point (the mock socket's `simulateMessage`, exactly as the other
 * store tests do) and asserting the observable consequence.
 *
 * `CASES` is a `Record<WorkerServerMessageType, ...>`, so adding a type to
 * `WORKER_SERVER_MESSAGE_TYPES` without adding a fixture here is a TYPE ERROR,
 * and `handleMessage`'s `never` default makes a missing `case` a type error in
 * the store itself -- the two halves that together close the #959 PR-C
 * silent drop (a new message type the dispatcher quietly ignored).
 *
 * A type this store deliberately does not act on is still listed, with the
 * reason, and asserts that nothing observable changed. Guard-logic semantics
 * inside a handler (epoch comparison direction, contiguity) are NOT covered
 * here; they stay with the E2E and review disciplines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { WorkerServerMessage, WorkerServerMessageType } from '@agent-console/shared';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { getOrCreateTerminal, _resetTerminals } from '../terminal-store';

type Instance = ReturnType<typeof getOrCreateTerminal>;

interface Ctx {
  instance: Instance;
  ws: MockWebSocket;
  /** The request-history-range id captured by a case's setup, when it needs one. */
  rangeRequestId: number | null;
}

interface WireCase {
  /** Brings the store to the state this frame is meaningful in (optional). */
  setup?: (ctx: Ctx) => Promise<void>;
  /** A real-shaped frame (typed against the wire union, so a wrong shape fails tsc). */
  frame: (ctx: Ctx) => WorkerServerMessage;
  /** The observable consequence, or `null` for a deliberate no-op (then `noOpReason` is required). */
  assert: ((ctx: Ctx, before: Snapshot) => void) | null;
  noOpReason?: string;
}

type Snapshot = ReturnType<Instance['getSnapshot']>;

const flush = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function text(instance: Instance): string {
  return instance
    .getSnapshot()
    .rows.map((r) => r.segments.map((s) => s.text).join(''))
    .join('\n');
}

/** What a no-op frame must leave untouched. */
function observable(s: Snapshot) {
  return {
    status: s.status,
    exitInfo: s.exitInfo,
    notice: s.notice,
    workerError: s.workerError,
    activityState: s.activityState,
    loadingHistory: s.loadingHistory,
    rowCount: s.rows.length,
    pagedRowCount: s.pagedRowCount,
  };
}

const CASES: Record<WorkerServerMessageType, WireCase> = {
  output: {
    frame: () => ({ type: 'output', data: 'wire-output-line\r\n', offset: 18, epoch: 1 }),
    assert: ({ instance }) => {
      expect(text(instance)).toContain('wire-output-line');
    },
  },
  exit: {
    frame: () => ({ type: 'exit', exitCode: 3, signal: null }),
    assert: ({ instance }) => {
      const s = instance.getSnapshot();
      expect(s.status).toBe('exited');
      expect(s.exitInfo).toEqual({ code: 3, signal: null });
    },
  },
  history: {
    frame: () => ({ type: 'history', data: 'wire-history-line\r\n', offset: 19, startOffset: 0, epoch: 1 }),
    assert: ({ instance }, before) => {
      // The open socket issued request-history, so loading was in flight; the reply clears it.
      expect(before.loadingHistory).toBe(true);
      expect(text(instance)).toContain('wire-history-line');
      expect(instance.getSnapshot().loadingHistory).toBe(false);
    },
  },
  activity: {
    frame: () => ({ type: 'activity', state: 'asking' }),
    assert: ({ instance }) => {
      expect(instance.getSnapshot().activityState).toBe('asking');
    },
  },
  error: {
    frame: () => ({ type: 'error', message: 'wire boom', code: 'ACTIVATION_FAILED' }),
    assert: ({ instance }) => {
      expect(instance.getSnapshot().workerError).toEqual({ message: 'wire boom', code: 'ACTIVATION_FAILED' });
    },
  },
  'server-restarted': {
    frame: () => ({ type: 'server-restarted', serverPid: 4242 }),
    assert: null,
    noOpReason: 'a restarted server needs no client cache invalidation; the epoch gate handles incarnation changes',
  },
  'history-range': {
    // A range reply is only accepted for the single in-flight request that abuts the window top.
    setup: async (ctx) => {
      ctx.ws.simulateMessage(
        JSON.stringify({ type: 'history', data: 'seed\r\n', offset: 100, startOffset: 50, epoch: 1 } satisfies WorkerServerMessage),
      );
      await flush();
      ctx.instance.requestOlderHistory();
      const sent = ctx.ws.send.mock.calls.map((c) => JSON.parse(c[0]) as { type: string; requestId?: number });
      const req = [...sent].reverse().find((m) => m.type === 'request-history-range');
      if (typeof req?.requestId !== 'number') throw new Error('setup: no request-history-range was sent');
      ctx.rangeRequestId = req.requestId;
    },
    frame: (ctx) => ({
      type: 'history-range',
      requestId: ctx.rangeRequestId ?? -1,
      data: 'wire-range-line\r\n',
      startOffset: 10,
      endOffset: 50,
      hasMore: true,
      epoch: 1,
    }),
    assert: ({ instance }, before) => {
      expect(before.pagedRowCount).toBe(0);
      expect(instance.getSnapshot().pagedRowCount).toBeGreaterThan(0);
    },
  },
  'restore-info': {
    frame: () => ({
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 3,
      repairedToolCallIds: [],
      completed: true,
    }),
    assert: null,
    noOpReason: 'restore-info is an embedded-agent (Transcript Restore) message; a PTY terminal has nothing to render for it',
  },
};

describe('terminal-store wire consumption (one real frame per WorkerServerMessage type)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetTerminals();
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

  it.each(Object.entries(CASES) as Array<[WorkerServerMessageType, WireCase]>)('%s changes (or deliberately leaves) the store state', async (type, wireCase) => {
    const instance = getOrCreateTerminal(`wire-${type}`, 'w');
    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('no ws');
    ws.simulateOpen();
    const ctx: Ctx = { instance, ws, rangeRequestId: null };
    await wireCase.setup?.(ctx);
    const before = instance.getSnapshot();
    const beforeObservable = observable(before);

    const frame = wireCase.frame(ctx);
    expect(frame.type).toBe(type);
    expect(() => ws.simulateMessage(JSON.stringify(frame))).not.toThrow();
    await flush();

    if (wireCase.assert === null) {
      expect(wireCase.noOpReason).toBeTruthy();
      expect(observable(instance.getSnapshot())).toEqual(beforeObservable);
      return;
    }
    wireCase.assert(ctx, before);
  });
});
