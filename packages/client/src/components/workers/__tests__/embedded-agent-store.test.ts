import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AppServerMessage } from '@agent-console/shared';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import {
  getOrCreateEmbeddedAgentWorker,
  _resetEmbeddedAgentWorkers,
  _setAppSubscribe,
  _inspect,
  type EmbeddedAgentChatEntry,
} from '../embedded-agent-store';

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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function lastSentMessages(ws: MockWebSocket): unknown[] {
  const calls = ws.send.mock.calls as unknown as string[][];
  return calls.map((call) => JSON.parse(call[0]));
}

function historyMessage(data: string, offset: number, startOffset = 0, epoch = 1) {
  return JSON.stringify({ type: 'history', data, offset, startOffset, epoch });
}

function outputMessage(data: string, offset: number, epoch = 1) {
  return JSON.stringify({ type: 'output', data, offset, epoch });
}

function ndjson(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('embedded-agent-store', () => {
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
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  it('requests full history with fromOffset 0 on open', () => {
    getOrCreateEmbeddedAgentWorker('s1', 'w1');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const sent = lastSentMessages(ws!);
    expect(sent).toContainEqual({ type: 'request-history', fromOffset: 0 });
  });

  it('folds a user-message + assistant-message pair from history into entries', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s2', 'w2');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson(
      { v: 1, type: 'user-message', id: 'u1', text: 'hello' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'hi there' },
    );
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'user-message', id: 'u1', text: 'hello' });
    expect(entries[1]).toMatchObject({ kind: 'assistant-message', text: 'hi there', streaming: false });
  });

  it('accumulates assistant-delta chunks into a single streaming entry, then finalizes on assistant-message', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3', 'w3');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    let offset = 0;
    const chunk1 = ndjson({ v: 1, type: 'assistant-delta', turnId: 't1', text: 'Hel' });
    ws!.simulateMessage(outputMessage(chunk1, (offset += chunk1.length)));
    await flush();

    let entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant-message', text: 'Hel', streaming: true });

    const chunk2 = ndjson({ v: 1, type: 'assistant-delta', turnId: 't1', text: 'lo' });
    ws!.simulateMessage(outputMessage(chunk2, (offset += chunk2.length)));
    await flush();

    entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant-message', text: 'Hello', streaming: true });

    const final = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: 'Hello' });
    ws!.simulateMessage(outputMessage(final, (offset += final.length)));
    await flush();

    entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant-message', text: 'Hello', streaming: false });
  });

  it('a second assistant-message round for the same turnId (post-tool-call) creates a NEW entry, not a merge', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3b', 'w3b');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson(
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'first round' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run_process', args: {} },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'second round' },
    );
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    const assistantEntries = entries.filter((e) => e.kind === 'assistant-message');
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[0]).toMatchObject({ text: 'first round' });
    expect(assistantEntries[1]).toMatchObject({ text: 'second round' });
  });

  it('pairs a tool-result with its tool-call by callId, including error styling data', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s4', 'w4');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson(
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run_process', args: { cmd: 'ls' } },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: false, result: 'boom' },
    );
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool-call',
      name: 'run_process',
      result: { ok: false, result: 'boom' },
    });
  });

  it('folds server-authored exited events from replayed history (full EmbeddedAgentStreamEvent union)', async () => {
    // Architect pre-directive #3 (Issue #1021): the client MUST parse replayed
    // history with the full EmbeddedAgentStreamEventSchema union, not the
    // loop-only EmbeddedAgentEventSchema -- otherwise server-authored rows
    // like `exited` (and `user-message`) would be silently dropped.
    const instance = getOrCreateEmbeddedAgentWorker('s5', 'w5');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'exited', code: 1 });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'exited', code: 1 });
  });

  it('folds a user-message server-authored event from replayed history', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s5b', 'w5b');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hi' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user-message', id: 'u1', text: 'hi' });
  });

  it('ignores state events (recognized but not rendered) without adding an entry', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s6', 'w6');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'state', state: 'active' }, { v: 1, type: 'user-message', id: 'u1', text: 'hi' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('user-message');
  });

  it('skips a malformed JSON line without throwing', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s7', 'w7');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = 'not-json\n' + ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hi' });
    expect(() => ws!.simulateMessage(historyMessage(data, data.length))).not.toThrow();
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('user-message');
  });

  it('skips a valid-JSON line with an unrecognized type without throwing', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s8', 'w8');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'some-future-event', foo: 'bar' }, { v: 1, type: 'user-message', id: 'u1', text: 'hi' });
    expect(() => ws!.simulateMessage(historyMessage(data, data.length))).not.toThrow();
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('user-message');
  });

  it('carries a partial line across two chunks (NDJSON line splitting)', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s9', 'w9');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const full = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hello world' });
    const splitAt = Math.floor(full.length / 2);
    const part1 = full.slice(0, splitAt);
    const part2 = full.slice(splitAt);

    // history establishes epoch/startOffset; the partial line then arrives via
    // 'output' across two separate messages.
    ws!.simulateMessage(historyMessage('', 0, 0));
    await flush();
    ws!.simulateMessage(outputMessage(part1, part1.length));
    await flush();

    expect(instance.getSnapshot().entries).toHaveLength(0);

    ws!.simulateMessage(outputMessage(part2, part1.length + part2.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user-message', text: 'hello world' });
  });

  it('updates activityState from activity messages', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s10', 'w10');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    await flush();

    expect(instance.getSnapshot().activityState).toBe('active');
  });

  it('records a non-fatal ACTIVATION_FAILED error without clearing accumulated entries', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s11', 'w11');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hi' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    ws!.simulateMessage(JSON.stringify({ type: 'error', message: 'dangling definition', code: 'ACTIVATION_FAILED' }));
    await flush();

    const snapshot = instance.getSnapshot();
    expect(snapshot.workerError).toEqual({ message: 'dangling definition', code: 'ACTIVATION_FAILED' });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.status).toBe('connected'); // socket stays open per architect directive #2
  });

  it('records a TURN_IN_PROGRESS error non-fatally', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s12', 'w12');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(JSON.stringify({ type: 'error', message: 'turn in progress', code: 'TURN_IN_PROGRESS' }));
    await flush();

    expect(instance.getSnapshot().workerError?.code).toBe('TURN_IN_PROGRESS');
  });

  it('dismissError clears the worker error without reconnecting', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s13', 'w13');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(JSON.stringify({ type: 'error', message: 'turn in progress', code: 'TURN_IN_PROGRESS' }));
    await flush();
    expect(instance.getSnapshot().workerError).not.toBeNull();

    instance.dismissError();
    expect(instance.getSnapshot().workerError).toBeNull();
  });

  it('sendUserMessage serializes the embedded-user-message client message', () => {
    const instance = getOrCreateEmbeddedAgentWorker('s14', 'w14');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    instance.sendUserMessage('hello agent');

    const sent = lastSentMessages(ws!);
    expect(sent).toContainEqual({ type: 'embedded-user-message', text: 'hello agent' });
  });

  it('cancel serializes the embedded-cancel client message', () => {
    const instance = getOrCreateEmbeddedAgentWorker('s15', 'w15');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    instance.cancel();

    const sent = lastSentMessages(ws!);
    expect(sent).toContainEqual({ type: 'embedded-cancel' });
  });

  it('restart forces a fresh WebSocket connection', () => {
    getOrCreateEmbeddedAgentWorker('s16', 'w16');
    const firstWs = MockWebSocket.getLastInstance();
    firstWs!.simulateOpen();

    const instance = getOrCreateEmbeddedAgentWorker('s16', 'w16');
    instance.restart();

    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(firstWs);
  });

  it('resets accumulated entries on an epoch bump (worker restarted server-side)', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s17', 'w17');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data1 = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'before restart' });
    ws!.simulateMessage(historyMessage(data1, data1.length, 0, 1));
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(1);

    // A larger epoch means the worker restarted server-side (fresh
    // activation); accumulated chat state must be dropped.
    const data2 = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'after restart' });
    ws!.simulateMessage(outputMessage(data2, data2.length, 2));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(0); // epoch mismatch discards the triggering payload
    // The store re-requests fresh history for the new epoch (single-flight).
    const sent = lastSentMessages(ws!);
    expect(sent.filter((m) => (m as { type: string }).type === 'request-history')).toHaveLength(2);
  });

  it('disposes and re-subscribes to app-ws session-deleted', () => {
    const bus = makeAppBus();
    _setAppSubscribe(bus.subscribe);

    const instance = getOrCreateEmbeddedAgentWorker('s18', 'w18');
    expect(_inspect(instance).disposed).toBe(false);

    bus.emit({ type: 'session-deleted', sessionId: 's18' } as AppServerMessage);

    expect(_inspect(instance).disposed).toBe(true);
  });

  it('does not dispose on session-deleted for a different session', () => {
    const bus = makeAppBus();
    _setAppSubscribe(bus.subscribe);

    const instance = getOrCreateEmbeddedAgentWorker('s19', 'w19');
    bus.emit({ type: 'session-deleted', sessionId: 'other-session' } as AppServerMessage);

    expect(_inspect(instance).disposed).toBe(false);
  });

  it('a tool-result for an unknown callId is dropped defensively, not fabricated', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s20', 'w20');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'tool-result', turnId: 't1', callId: 'unknown-call', ok: true, result: 'x' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    expect(instance.getSnapshot().entries).toHaveLength(0);
  });

  it('boundary: an empty history payload folds to zero entries without error', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s21', 'w21');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    ws!.simulateMessage(historyMessage('', 0, 0));
    await flush();

    expect(instance.getSnapshot().entries).toHaveLength(0);
    expect(instance.getSnapshot().loadingHistory).toBe(false);
  });

  it('getOrCreateEmbeddedAgentWorker returns the SAME instance for the same key', () => {
    const a = getOrCreateEmbeddedAgentWorker('same', 'worker');
    const b = getOrCreateEmbeddedAgentWorker('same', 'worker');
    expect(a).toBe(b);
  });
});

// Type-level smoke check: entries must be a discriminated union covering all
// kinds this file exercises (compile-time guard against a future kind being
// dropped from the store's exported type).
function _typeCheck(entry: EmbeddedAgentChatEntry): string {
  return entry.kind;
}
void _typeCheck;
