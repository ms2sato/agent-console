/**
 * Wire-consumption fixtures for the embedded-agent store: one real-shaped
 * `WorkerServerMessage` frame per `WorkerServerMessageType`, fed through the
 * REAL entry point (the mock socket's `simulateMessage`) and asserting the
 * observable consequence.
 *
 * `CASES` is a `Record<WorkerServerMessageType, ...>`, so adding a type to
 * `WORKER_SERVER_MESSAGE_TYPES` without a fixture here is a TYPE ERROR, and the
 * dispatcher's `never` default makes a missing `case` a type error in the store.
 * The same pattern covers `terminal-store` and `useAppWs`.
 *
 * A type this store deliberately ignores is still listed, with the reason, and
 * asserts that nothing observable changed. Guard-logic semantics inside a
 * handler stay with the E2E and review disciplines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { WorkerServerMessage, WorkerServerMessageType } from '@agent-console/shared';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { getOrCreateEmbeddedAgentWorker, _resetEmbeddedAgentWorkers } from '../embedded-agent-store';

type Instance = ReturnType<typeof getOrCreateEmbeddedAgentWorker>;
type Snapshot = ReturnType<Instance['getSnapshot']>;

interface WireCase {
  /** A real-shaped frame, typed against the wire union so a wrong shape fails tsc. */
  frame: () => WorkerServerMessage;
  /** The observable consequence, or `null` for a deliberate no-op (then `noOpReason` is required). */
  assert: ((instance: Instance, before: Snapshot) => void) | null;
  noOpReason?: string;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/** One NDJSON line carrying a `context-usage` event: a real stream event with a directly observable fold. */
const usageLine = (promptTokens: number): string =>
  JSON.stringify({ v: 1, type: 'context-usage', promptTokens, estimated: false }) + '\n';

/** What a no-op frame must leave untouched. */
function observable(s: Snapshot) {
  return {
    activityState: s.activityState,
    workerError: s.workerError,
    restoring: s.restoring,
    contextUsage: s.contextUsage,
    entryCount: s.entries.length,
    currentExit: s.currentExit,
  };
}

const CASES: Record<WorkerServerMessageType, WireCase> = {
  output: {
    frame: () => {
      const data = usageLine(111);
      return { type: 'output', data, offset: data.length, epoch: 1 };
    },
    assert: (instance) => {
      expect(instance.getSnapshot().contextUsage).toEqual({ promptTokens: 111, estimated: false });
    },
  },
  history: {
    frame: () => {
      const data = usageLine(222);
      return { type: 'history', data, offset: data.length, startOffset: 0, epoch: 1 };
    },
    assert: (instance) => {
      expect(instance.getSnapshot().contextUsage).toEqual({ promptTokens: 222, estimated: false });
    },
  },
  activity: {
    frame: () => ({ type: 'activity', state: 'active' }),
    assert: (instance, before) => {
      expect(before.activityState).not.toBe('active');
      expect(instance.getSnapshot().activityState).toBe('active');
    },
  },
  error: {
    frame: () => ({ type: 'error', message: 'wire boom', code: 'ACTIVATION_FAILED' }),
    assert: (instance) => {
      expect(instance.getSnapshot().workerError).toEqual({ message: 'wire boom', code: 'ACTIVATION_FAILED' });
    },
  },
  'restore-info': {
    // An in-progress restore (`completed: false`) is what flips `restoring` on.
    frame: () => ({
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 2,
      repairedToolCallIds: [],
      completed: false,
    }),
    assert: (instance, before) => {
      expect(before.restoring).toBe(false);
      expect(instance.getSnapshot().restoring).toBe(true);
    },
  },
  exit: {
    frame: () => ({ type: 'exit', exitCode: 3, signal: null }),
    assert: null,
    noOpReason:
      "PTY-only in practice: the server represents an embedded subprocess's exit as an `exited` NDJSON row (the socket stays open)",
  },
  'history-range': {
    frame: () => ({
      type: 'history-range',
      requestId: 1,
      data: '',
      startOffset: 0,
      endOffset: 0,
      hasMore: false,
      epoch: 1,
    }),
    assert: null,
    noOpReason: 'no UI requests older ranges for embedded-agent in v1 (no scroll-up paging over chat history)',
  },
  'server-restarted': {
    frame: () => ({ type: 'server-restarted', serverPid: 4242 }),
    assert: null,
    noOpReason: 'embedded-agent workers rely on the epoch-mismatch mechanism; no explicit push is sent',
  },
};

describe('embedded-agent-store wire consumption (one real frame per WorkerServerMessage type)', () => {
  let restoreWebSocket: () => void;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket();
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it.each(Object.entries(CASES) as Array<[WorkerServerMessageType, WireCase]>)(
    '%s changes (or deliberately leaves) the store state',
    async (type, wireCase) => {
      const instance = getOrCreateEmbeddedAgentWorker(`wire-${type}`, 'w');
      const ws = MockWebSocket.getLastInstance();
      if (!ws) throw new Error('no ws');
      ws.simulateOpen();
      await flush();
      const before = instance.getSnapshot();
      const beforeObservable = observable(before);

      const frame = wireCase.frame();
      expect(frame.type).toBe(type);
      expect(() => ws.simulateMessage(JSON.stringify(frame))).not.toThrow();
      await flush();

      if (wireCase.assert === null) {
        expect(wireCase.noOpReason).toBeTruthy();
        expect(observable(instance.getSnapshot())).toEqual(beforeObservable);
        return;
      }
      wireCase.assert(instance, before);
    },
  );
});
