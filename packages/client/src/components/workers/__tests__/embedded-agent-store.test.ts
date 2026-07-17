import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { WS_CLOSE_CODE, type AppServerMessage } from '@agent-console/shared';
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

  it('accumulates assistant-thinking-delta chunks into a separate streaming entry, then finalizes on assistant-message (without merging)', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3c', 'w3c');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    let offset = 0;
    const chunk1 = ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'Let me ' });
    ws!.simulateMessage(outputMessage(chunk1, (offset += chunk1.length)));
    await flush();

    let entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant-thinking', text: 'Let me ', streaming: true });

    const chunk2 = ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'think' });
    ws!.simulateMessage(outputMessage(chunk2, (offset += chunk2.length)));
    await flush();

    entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant-thinking', text: 'Let me think', streaming: true });

    // The finalize signal is the arrival of assistant-message for the same
    // turnId (there is no terminal assistant-thinking-delta event).
    const final = ndjson({ v: 1, type: 'assistant-message', turnId: 't1', text: 'Here is my answer' });
    ws!.simulateMessage(outputMessage(final, (offset += final.length)));
    await flush();

    entries = instance.getSnapshot().entries;
    // Two SEPARATE entries: the finalized thinking entry and the new
    // assistant-message entry -- never merged into one.
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'assistant-thinking', text: 'Let me think', streaming: false });
    expect(entries[1]).toMatchObject({ kind: 'assistant-message', text: 'Here is my answer', streaming: false });
  });

  it('finalizes an open assistant-thinking entry on turn-error for the same turnId', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3d', 'w3d');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson(
      { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking...' },
      { v: 1, type: 'turn-error', turnId: 't1', message: 'boom' },
    );
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    const thinkingEntry = entries.find((e) => e.kind === 'assistant-thinking');
    expect(thinkingEntry).toMatchObject({ text: 'thinking...', streaming: false });
  });

  it('finalizes an open assistant-thinking entry on fatal', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3e', 'w3e');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson(
      { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking...' },
      { v: 1, type: 'fatal', message: 'boom' },
    );
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    const thinkingEntry = entries.find((e) => e.kind === 'assistant-thinking');
    expect(thinkingEntry).toMatchObject({ text: 'thinking...', streaming: false });
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

    // Never confirmed within this test -- swallow the eventual dispose-time
    // rejection (afterEach's _resetEmbeddedAgentWorkers) so it doesn't
    // surface as an unhandled rejection.
    instance.sendUserMessage('hello agent').catch(() => {});

    const sent = (
      lastSentMessages(ws!) as { type: string; text?: string; clientMessageId?: string }[]
    ).find((m) => m.type === 'embedded-user-message')!;
    expect(sent.text).toBe('hello agent');
    // Issue #1117: a per-send correlation id, generated client-side, so the
    // server's echo can be matched back to THIS specific send.
    expect(typeof sent.clientMessageId).toBe('string');
    expect(sent.clientMessageId?.length).toBeGreaterThan(0);
  });

  describe('sendUserMessage confirmation (#1024: preserve draft on reject)', () => {
    it('resolves once the server echoes the message back as a user-message event carrying the SAME clientMessageId (correlated, not "any echo")', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s30', 'w30');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello agent');
      let settled = false;
      sendPromise.then(() => {
        settled = true;
      });
      await flush();
      // Not yet confirmed -- the server hasn't echoed the message back.
      expect(settled).toBe(false);

      const sentClientMessageId = (
        lastSentMessages(ws!) as { type: string; clientMessageId?: string }[]
      ).find((m) => m.type === 'embedded-user-message')?.clientMessageId;
      expect(sentClientMessageId).toBeTruthy();

      const data = ndjson({
        v: 1,
        type: 'user-message',
        id: 'u1',
        text: 'hello agent',
        clientMessageId: sentClientMessageId,
      });
      ws!.simulateMessage(outputMessage(data, data.length));

      await expect(sendPromise).resolves.toBeUndefined();
    });

    it('rejects when the server rejects the send (e.g. TURN_IN_PROGRESS)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s31', 'w31');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello agent');
      ws!.simulateMessage(
        JSON.stringify({ type: 'error', message: 'turn in progress', code: 'TURN_IN_PROGRESS' }),
      );

      await expect(sendPromise).rejects.toThrow();
    });

    it('rejects immediately when the socket is not open', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s32', 'w32');
      // Deliberately do NOT simulateOpen(): the socket stays CONNECTING.

      await expect(instance.sendUserMessage('hello agent')).rejects.toThrow();
    });

    it('rejects a pending send when the worker epoch resets (server restart) before confirmation', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s33', 'w33');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      // Establish the baseline epoch (1) via the initial history response.
      ws!.simulateMessage(historyMessage('', 0, 0, 1));
      await flush();

      const sendPromise = instance.sendUserMessage('hello agent');

      // A larger epoch than recorded means the worker restarted server-side.
      const data = ndjson({ v: 1, type: 'ready' });
      ws!.simulateMessage(JSON.stringify({ type: 'output', data, offset: data.length, epoch: 2 }));

      await expect(sendPromise).rejects.toThrow();
    });

    it('rejects a still-pending prior send when a newer send starts first (defensive, no hanging promise)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s34', 'w34');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const first = instance.sendUserMessage('first');
      const second = instance.sendUserMessage('second');

      await expect(first).rejects.toThrow();

      const sentMessages = lastSentMessages(ws!) as { clientMessageId?: string }[];
      const secondClientMessageId = sentMessages[sentMessages.length - 1]?.clientMessageId;
      expect(secondClientMessageId).toBeTruthy();

      const data = ndjson({
        v: 1,
        type: 'user-message',
        id: 'u2',
        text: 'second',
        clientMessageId: secondClientMessageId,
      });
      ws!.simulateMessage(outputMessage(data, data.length));

      await expect(second).resolves.toBeUndefined();
    });

    it('rejects a pending send on dispose (cleanup, no hanging promise)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s35', 'w35');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello agent');
      instance.dispose();

      await expect(sendPromise).rejects.toThrow();
    });

    it('rejects a pending send when the socket closes with a no-reconnect close code (architect audit R1a)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s36', 'w36');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello agent');
      // No reconnect will follow this code, so no future echo/error can ever
      // settle the pending send.
      ws!.simulateClose(WS_CLOSE_CODE.NORMAL_CLOSURE);

      await expect(sendPromise).rejects.toThrow();
    });

    it('rejects a pending send when the socket closes after noReconnect was latched by a prior fatal error (architect audit R1a)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s36b', 'w36b');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      // Latches noReconnect without itself leaving a pending send behind.
      ws!.simulateMessage(JSON.stringify({ type: 'error', message: 'session deleted', code: 'SESSION_DELETED' }));

      const sendPromise = instance.sendUserMessage('hello agent');
      ws!.simulateClose();

      await expect(sendPromise).rejects.toThrow();
    });

    it('rejects a pending send when a same-epoch reconnect\'s history reply carries no confirming echo (architect audit R1b)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s37', 'w37');
      const firstWs = MockWebSocket.getLastInstance();
      firstWs!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello agent');

      // Connection drops before the server received the write; a fresh
      // connection is established for the SAME epoch (no epoch bump).
      instance.restart();
      const secondWs = MockWebSocket.getLastInstance();
      secondWs!.simulateOpen();

      // The reconnect's history reply covers everything from offset 0, but
      // contains no echo of the message -- the write never reached the server.
      secondWs!.simulateMessage(historyMessage('', 0, 0, 1));

      await expect(sendPromise).rejects.toThrow();
    });

    it('resolves a pending send when a same-epoch reconnect\'s history reply DOES carry the confirming echo (architect audit R1b, positive polarity)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s37b', 'w37b');
      const firstWs = MockWebSocket.getLastInstance();
      firstWs!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello agent');
      const sentClientMessageId = (
        lastSentMessages(firstWs!) as { type: string; clientMessageId?: string }[]
      ).find((m) => m.type === 'embedded-user-message')?.clientMessageId;
      expect(sentClientMessageId).toBeTruthy();

      // The write DID reach the server before the connection dropped -- the
      // reconnect's history reply replays it back.
      instance.restart();
      const secondWs = MockWebSocket.getLastInstance();
      secondWs!.simulateOpen();

      const data = ndjson({
        v: 1,
        type: 'user-message',
        id: 'u1',
        text: 'hello agent',
        clientMessageId: sentClientMessageId,
      });
      secondWs!.simulateMessage(historyMessage(data, data.length, 0, 1));

      await expect(sendPromise).resolves.toBeUndefined();
    });

    it('does NOT resolve the pending send on a user-message echo carrying a DIFFERENT clientMessageId (multi-client false-confirm regression, Issue #1117); the echo still folds as an entry, and the pending later settles via the existing history-fold-reject path', async () => {
      // Simulates the exact bug: the SAME embedded-agent worker open in two
      // tabs/clients both send concurrently. Another client's send is
      // accepted and echoed first -- that echo must NOT resolve THIS
      // client's still-pending send (it isn't the confirmation for OUR
      // send), even though pre-#1117 code resolved on ANY user-message echo
      // regardless of correlation id.
      const instance = getOrCreateEmbeddedAgentWorker('s37c', 'w37c');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello from tab A');
      let settled = false;
      let rejected = false;
      sendPromise.then(
        () => {
          settled = true;
        },
        () => {
          rejected = true;
        },
      );

      // Another client's (tab B's) send is accepted and echoed back first,
      // with a DIFFERENT clientMessageId.
      const otherClientEcho = ndjson({
        v: 1,
        type: 'user-message',
        id: 'u-other',
        text: 'hello from tab B',
        clientMessageId: 'some-other-clients-uuid',
      });
      ws!.simulateMessage(outputMessage(otherClientEcho, otherClientEcho.length));
      await flush();

      // The other client's message still folds as an ordinary chat entry...
      const entries = instance.getSnapshot().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'user-message', text: 'hello from tab B' });
      // ...but it must NOT have resolved (nor rejected) our pending send.
      expect(settled).toBe(false);
      expect(rejected).toBe(false);

      // The pending send eventually settles via the EXISTING history-fold-reject
      // path (a same-epoch reconnect whose history reply carries no confirming
      // echo for OUR clientMessageId) -- unchanged by this Issue, reused here
      // only to observe that the pending slot is still live (not already
      // resolved by the mismatched echo above).
      instance.restart();
      const secondWs = MockWebSocket.getLastInstance();
      secondWs!.simulateOpen();
      secondWs!.simulateMessage(historyMessage('', 0, 0, 1));

      await expect(sendPromise).rejects.toThrow();
    });

    it('does NOT resolve the pending send on a user-message echo with NO clientMessageId field at all (replayed pre-#1117 history row / legacy echo)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s37d', 'w37d');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const sendPromise = instance.sendUserMessage('hello agent');
      let settled = false;
      let rejected = false;
      sendPromise.then(
        () => {
          settled = true;
        },
        () => {
          rejected = true;
        },
      );

      // A legacy-shaped echo -- no clientMessageId field at all (e.g. a
      // replayed history row persisted before this field existed).
      const legacyEcho = ndjson({ v: 1, type: 'user-message', id: 'u-legacy', text: 'legacy row' });
      ws!.simulateMessage(outputMessage(legacyEcho, legacyEcho.length));
      await flush();

      const entries = instance.getSnapshot().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'user-message', text: 'legacy row' });
      expect(settled).toBe(false);
      expect(rejected).toBe(false);

      // Confirm the pending slot is still live via the existing reject path.
      instance.restart();
      const secondWs = MockWebSocket.getLastInstance();
      secondWs!.simulateOpen();
      secondWs!.simulateMessage(historyMessage('', 0, 0, 1));

      await expect(sendPromise).rejects.toThrow();
    });
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

  it('preserves accumulated entries on a plain reconnect resume (fromOffset > 0, same epoch, startOffset === requestedFromOffset)', async () => {
    // Complements the epoch-bump tests below: this is the common-case
    // reconnect (no server restart) where the client already has some
    // history cached and asks only for the tail. Issue #1021/#1022's
    // CRITICAL/MAJOR bugs were both in the epoch-reset paths; this test
    // pins down the plain incremental-resume path so a future change to
    // applyBytes's `isFresh` logic can't silently start resetting it too.
    const instance = getOrCreateEmbeddedAgentWorker('s17c', 'w17c');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();

    const initialData = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'first' });
    ws1!.simulateMessage(historyMessage(initialData, initialData.length, 0, 1));
    await flush();
    const entriesAfterFirst = instance.getSnapshot().entries;
    expect(entriesAfterFirst).toHaveLength(1);
    const firstEntryRef = entriesAfterFirst[0];

    // Force a fresh WS connection without an epoch bump (a plain reconnect,
    // e.g. a dropped connection resuming) -- lastOffset carries over from
    // the prior connection.
    instance.restart();
    const ws2 = MockWebSocket.getLastInstance();
    expect(ws2).not.toBe(ws1);
    ws2!.simulateOpen();

    const sent = lastSentMessages(ws2!);
    expect(sent).toContainEqual({ type: 'request-history', fromOffset: initialData.length });

    // The server's response starts exactly where requested (not a fresh
    // load) and carries only the new tail.
    const tailData = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'second' });
    ws2!.simulateMessage(
      historyMessage(tailData, initialData.length + tailData.length, initialData.length, 1),
    );
    await flush();

    const entriesAfterSecond = instance.getSnapshot().entries;
    // The pre-existing entry is the SAME object reference -- proof
    // resetChatState was NOT invoked (a reset replaces `entries` with a
    // brand-new empty array, which would also change this reference).
    expect(entriesAfterSecond[0]).toBe(firstEntryRef);
    expect(entriesAfterSecond).toHaveLength(2);
    expect(entriesAfterSecond[0]).toMatchObject({ kind: 'user-message', text: 'first' });
    expect(entriesAfterSecond[1]).toMatchObject({ kind: 'user-message', text: 'second' });
  });

  it('resets accumulated entries when the server prunes and returns a startOffset different from what was requested, while the epoch stays the SAME (architect audit follow-up #1114)', async () => {
    // Complements the plain-resume test above (same epoch, startOffset ===
    // requestedFromOffset -> no reset) and the epoch-bump tests below
    // (epoch differs -> reset via beginEpochReset/acceptEpoch). This is the
    // third, previously-uncovered branch: the epoch is unchanged (no server
    // restart) but the history response's startOffset does not match what
    // was requested -- e.g. the server pruned its buffer and can only serve
    // from a different offset. applyBytes's `isFresh` check must still
    // treat this as a fresh load and reset chat state, entirely outside the
    // epoch-bump machinery (acceptEpoch short-circuits to true for
    // `epoch === this.epoch` and never calls beginEpochReset here).
    const instance = getOrCreateEmbeddedAgentWorker('s17d', 'w17d');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();

    const initialData = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'first' });
    ws1!.simulateMessage(historyMessage(initialData, initialData.length, 0, 1));
    await flush();
    const entriesAfterFirst = instance.getSnapshot().entries;
    expect(entriesAfterFirst).toHaveLength(1);
    const firstEntryRef = entriesAfterFirst[0];

    // Plain reconnect (no epoch bump): lastOffset carries over, so the
    // client requests fromOffset: initialData.length.
    instance.restart();
    const ws2 = MockWebSocket.getLastInstance();
    expect(ws2).not.toBe(ws1);
    ws2!.simulateOpen();
    expect(lastSentMessages(ws2!)).toContainEqual({
      type: 'request-history',
      fromOffset: initialData.length,
    });

    // The server responds with the SAME epoch (no restart) but pruned its
    // buffer, so it cannot resume from the requested offset and instead
    // sends a fresh payload starting at 0.
    const prunedData = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'second (post-prune)' });
    ws2!.simulateMessage(historyMessage(prunedData, prunedData.length, 0, 1));
    await flush();

    const entriesAfterPrune = instance.getSnapshot().entries;
    // Fresh reset: the old entry's reference must NOT survive -- the new
    // array is entirely rebuilt from the pruned payload, not appended to
    // the prior accumulation.
    expect(entriesAfterPrune).toHaveLength(1);
    expect(entriesAfterPrune[0]).not.toBe(firstEntryRef);
    expect(entriesAfterPrune[0]).toMatchObject({ kind: 'user-message', text: 'second (post-prune)' });

    // The reset went through applyBytes's isFresh branch, NOT
    // beginEpochReset's epoch-bump path: no second request-history was sent
    // on ws2 (beginEpochReset would issue one), and the resync-queue
    // machinery was never armed, so a subsequent live `output` for the same
    // epoch folds immediately instead of being queued.
    expect(
      lastSentMessages(ws2!).filter((m) => (m as { type: string }).type === 'request-history'),
    ).toHaveLength(1);

    const liveData = ndjson({ v: 1, type: 'user-message', id: 'u3', text: 'third (live)' });
    ws2!.simulateMessage(outputMessage(liveData, prunedData.length + liveData.length, 1));
    await flush();
    const entriesAfterLive = instance.getSnapshot().entries;
    expect(entriesAfterLive).toHaveLength(2);
    expect(entriesAfterLive[1]).toMatchObject({ kind: 'user-message', text: 'third (live)' });
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

  it('re-requests history for the new epoch even when an epoch bump arrives WHILE a history request is already in flight', async () => {
    // Race: unlike the previous test (where the epoch bump arrives only
    // AFTER the initial history response resolved historyInFlight back to
    // false), here the epoch-bumping message arrives while the initial
    // request-history is still outstanding. The old buggy behavior guarded
    // the re-request on `!historyInFlight`, so it was skipped entirely; the
    // eventual stale response for the OLD epoch would be dropped by
    // acceptEpoch (correct) but no fresh request for the NEW epoch was ever
    // sent, leaving the store stuck at loadingHistory: true forever.
    const instance = getOrCreateEmbeddedAgentWorker('s17b', 'w17b');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    // The initial connect-time request-history (fromOffset: 0) is now
    // outstanding: historyInFlight === true, no response yet.
    expect(lastSentMessages(ws!).filter((m) => (m as { type: string }).type === 'request-history')).toHaveLength(1);

    // Establish the first epoch via a live output chunk (does not itself
    // trigger a reset -- acceptEpoch only resets on a LATER mismatch).
    const data1 = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'first epoch' });
    ws!.simulateMessage(outputMessage(data1, data1.length, 1));
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(1);

    // Epoch bump arrives while the ORIGINAL request-history (sent on open,
    // still epoch-1-targeted) has not resolved yet.
    const data2 = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'second epoch' });
    ws!.simulateMessage(outputMessage(data2, data2.length, 2));
    await flush();

    // A fresh request-history for the new epoch must have been sent despite
    // the still-outstanding original request -- the store must not get
    // stuck.
    const sent = lastSentMessages(ws!);
    expect(sent.filter((m) => (m as { type: string }).type === 'request-history')).toHaveLength(2);
    expect(instance.getSnapshot().loadingHistory).toBe(true);
    expect(instance.getSnapshot().entries).toHaveLength(0); // reset by the epoch bump

    // The eventual stale response for the OLD epoch (1) must be dropped
    // without disturbing the fresh (epoch-2) request's in-flight state...
    const staleData = ndjson({ v: 1, type: 'user-message', id: 'stale', text: 'stale' });
    ws!.simulateMessage(historyMessage(staleData, staleData.length, 0, 1));
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0); // stale payload discarded

    // ...and the fresh (epoch-2) response must still be applied correctly,
    // proving the store is not permanently stuck.
    const freshData = ndjson({ v: 1, type: 'user-message', id: 'u3', text: 'fresh epoch-2 history' });
    ws!.simulateMessage(historyMessage(freshData, freshData.length, 0, 2));
    await flush();
    expect(instance.getSnapshot().loadingHistory).toBe(false);
    expect(instance.getSnapshot().entries).toHaveLength(1);
    expect(instance.getSnapshot().entries[0]).toMatchObject({ kind: 'user-message', text: 'fresh epoch-2 history' });
  });

  /**
   * Connects a fresh instance and triggers a genuine epoch bump (1 -> 2) via
   * a live output frame. The triggering frame itself is dropped by
   * acceptEpoch (returns false for the message that causes the reset, same
   * as the pre-existing epoch-mismatch contract) -- it is never queued nor
   * folded. Returns the instance/ws so the caller can drive the resync
   * window (queued output, then the epoch-2 history response) that follows.
   */
  function connectAndBumpEpoch(sessionId: string, workerId: string) {
    const instance = getOrCreateEmbeddedAgentWorker(sessionId, workerId);
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    const baseline = ndjson({ v: 1, type: 'user-message', id: 'baseline', text: 'epoch 1 baseline' });
    ws.simulateMessage(outputMessage(baseline, baseline.length, 1));

    const trigger = ndjson({ v: 1, type: 'user-message', id: 'trigger', text: 'epoch 2 trigger (dropped)' });
    ws.simulateMessage(outputMessage(trigger, trigger.length, 2));

    return { instance, ws };
  }

  it('does not duplicate a chat entry when live output for the new epoch arrives BEFORE its covering history response (architect audit MAJOR)', async () => {
    // The exact race from the architect's finding: beginEpochReset already
    // bumped `epoch`, so a SUBSEQUENT live `output` frame for that same new
    // epoch passes acceptEpoch and would previously have been folded
    // immediately via applyBytes. The eventual history response (requested
    // fromOffset: 0) then re-covers those same bytes, folding them a SECOND
    // time -- the Restart button reliably duplicating chat entries.
    const { instance, ws } = connectAndBumpEpoch('s20a', 'w20a');
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0); // reset by the bump; trigger frame dropped

    // Live output for the new epoch (e.g. the loop's own 'ready'/'state'
    // handshake, immediately at activation) arrives before the history
    // response. It must be QUEUED, not folded yet.
    const readyData = ndjson({ v: 1, type: 'user-message', id: 'ready', text: 'ready handshake' });
    ws.simulateMessage(outputMessage(readyData, readyData.length, 2));
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0); // queued, not folded

    // The history response covers exactly the same bytes (the server's
    // persisted stream already included them by the time it answered
    // request-history fromOffset: 0).
    ws.simulateMessage(historyMessage(readyData, readyData.length, 0, 2));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1); // exactly once, not duplicated
    expect(entries[0]).toMatchObject({ kind: 'user-message', text: 'ready handshake' });
    expect(instance.getSnapshot().loadingHistory).toBe(false);
  });

  it('drops queued output already covered by the history response but still applies output strictly beyond it', async () => {
    const { instance, ws } = connectAndBumpEpoch('s20b', 'w20b');
    await flush();

    // Two live frames arrive for the new epoch while resyncing, both
    // queued: one will end up COVERED by the history response (offset 100
    // <= the history's final offset 300) and one strictly NEWER (offset 500
    // > 300).
    const covered = ndjson({ v: 1, type: 'user-message', id: 'covered', text: 'queued-covered' });
    const newer = ndjson({ v: 1, type: 'user-message', id: 'newer', text: 'queued-newer' });
    ws.simulateMessage(outputMessage(covered, 100, 2));
    ws.simulateMessage(outputMessage(newer, 500, 2));
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0); // both queued, nothing folded yet

    const historyData = ndjson({ v: 1, type: 'user-message', id: 'history', text: 'history-payload' });
    ws.simulateMessage(historyMessage(historyData, 300, 0, 2));
    await flush();

    const texts = instance
      .getSnapshot()
      .entries.map((e) => (e.kind === 'user-message' ? e.text : null));
    // 'queued-covered' (offset 100 <= 300) must be dropped -- already
    // covered by the history payload. 'queued-newer' (offset 500 > 300)
    // must still be applied, in order, after the history payload's own
    // content.
    expect(texts).toEqual(['history-payload', 'queued-newer']);
  });

  it('flushes the resync queue on HISTORY_LOAD_FAILED instead of freezing live output forever (architect re-audit)', async () => {
    // Terminal-store avoids a stuck resync via its resync timeout (not
    // ported here -- see the `resyncing` field comment). The equivalent
    // guard for this store is an error-path flush: if the request-history
    // that would normally complete the resync fails server-side, nothing
    // else will ever call flushResyncQueue, so every subsequent live
    // `output` frame would silently accumulate in `queuedOutput` forever.
    const { instance, ws } = connectAndBumpEpoch('s20c', 'w20c');
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0);

    // A live frame arrives before the (about to fail) history response.
    const queuedData = ndjson({ v: 1, type: 'user-message', id: 'queued', text: 'queued before failure' });
    ws.simulateMessage(outputMessage(queuedData, queuedData.length, 2));
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0); // queued, not yet folded

    // The server reports the request-history itself failed.
    ws.simulateMessage(
      JSON.stringify({ type: 'error', message: 'history load failed', code: 'HISTORY_LOAD_FAILED' }),
    );
    await flush();

    // The queued frame must not be lost: flushResyncQueue(lastOffset) with
    // lastOffset still 0 (nothing folded yet in this failure path) applies
    // the entire queue -- nothing is dropped as "already covered" since no
    // history payload was ever folded.
    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user-message', text: 'queued before failure' });

    // The store must not be stuck: resyncing is confirmed false by
    // observing that a SUBSEQUENT live frame is applied immediately
    // (normal live-output path), not queued forever.
    const afterData = ndjson({ v: 1, type: 'user-message', id: 'after', text: 'after failure' });
    ws.simulateMessage(outputMessage(afterData, queuedData.length + afterData.length, 2));
    await flush();

    const finalEntries = instance.getSnapshot().entries;
    expect(finalEntries).toHaveLength(2);
    expect(finalEntries[1]).toMatchObject({ kind: 'user-message', text: 'after failure' });
  });

  it('resolves a pending send whose confirming echo is still queued when the epoch-2 history response lands (#1120: flush-before-reject ordering)', async () => {
    // Edge-of-edge race from the #1120 architect audit: a send is issued
    // while an epoch resync is outstanding, and its confirming echo arrives
    // as live output DURING the resync -- so it lands in the resync queue,
    // not folded yet. If the history response that completes the resync
    // rejects the pending send BEFORE flushing that queue, the reject fires
    // even though the very next step would have resolved it via the queued
    // echo.
    const { instance, ws } = connectAndBumpEpoch('s21', 'w21');
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0);

    const sendPromise = instance.sendUserMessage('hello agent');
    const sentClientMessageId = (
      lastSentMessages(ws) as { type: string; clientMessageId?: string }[]
    ).find((m) => m.type === 'embedded-user-message')?.clientMessageId;
    expect(sentClientMessageId).toBeTruthy();

    // The confirming echo arrives as live output for the new epoch while
    // still resyncing -- queued, not folded yet (resolvePendingSend has NOT
    // run at this point).
    const echoData = ndjson({
      v: 1,
      type: 'user-message',
      id: 'echo',
      text: 'hello agent',
      clientMessageId: sentClientMessageId,
    });
    ws.simulateMessage(outputMessage(echoData, 50, 2));
    await flush();
    expect(instance.getSnapshot().entries).toHaveLength(0); // queued, not folded

    // The epoch-2 history response lands, at an offset strictly BEFORE the
    // queued echo's offset (so the echo is not covered/dropped by the flush
    // -- it is genuinely newer and gets folded), and its own payload does
    // not itself contain a confirming user-message (empty).
    ws.simulateMessage(historyMessage('', 20, 0, 2));

    await expect(sendPromise).resolves.toBeUndefined();
    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user-message', text: 'hello agent' });
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
