import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { WS_CLOSE_CODE, type AppServerMessage, type RestorePreservation } from '@agent-console/shared';
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

function restoreInfoMessage(
  epoch: number,
  restoredMessageCount: number,
  repairedToolCallIds: string[] = [],
  completed = false,
  // R1: OMITTED by default, not defaulted to a boolean -- absence is a real
  // wire state (every `openai-api` worker), and a helper that quietly
  // supplied `false` would make it untestable.
  sdkResumed?: boolean,
) {
  return JSON.stringify({
    type: 'restore-info',
    epoch,
    restoredMessageCount,
    repairedToolCallIds,
    completed,
    ...(sdkResumed !== undefined ? { sdkResumed } : {}),
  });
}

/**
 * Failure form (#1449, extended #1447 stage 4 R4): carries none of the
 * success form's reconstruction-shaped fields. `preservation` is OMITTED by
 * default, not defaulted to a value -- absence is a real wire state
 * (a pre-stage-4 server), and a helper that quietly supplied one would make
 * it untestable, mirroring `restoreInfoMessage`'s `sdkResumed` discipline.
 */
function restoreFailureMessage(
  epoch: number,
  sdkResumed?: boolean,
  preservation?: RestorePreservation,
) {
  return JSON.stringify({
    type: 'restore-info',
    epoch,
    failed: true,
    ...(sdkResumed !== undefined ? { sdkResumed } : {}),
    ...(preservation !== undefined ? { preservation } : {}),
  });
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

  it('folds context-usage into snapshot.contextUsage without creating a chat entry', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3f', 'w3f');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'context-usage', promptTokens: 4200, estimated: false });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    expect(instance.getSnapshot().contextUsage).toEqual({ promptTokens: 4200, estimated: false });
    expect(instance.getSnapshot().entries).toHaveLength(0);
  });

  it('an ordinary context-usage reading does not refresh the transcript list', async () => {
    // `foldLine`'s boolean means "the entries array changed", and it drives
    // the caller's identity refresh of the list. A reading arrives every turn
    // and pushes nothing, so reporting a change here would re-publish the
    // transcript each turn for no reason. Observed as array identity, which
    // is the thing the refresh actually alters.
    const instance = getOrCreateEmbeddedAgentWorker('s3fu', 'w3fu');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const first = ndjson({ v: 1, type: 'context-usage', promptTokens: 4200, estimated: false });
    ws!.simulateMessage(historyMessage(first, first.length));
    await flush();
    const entriesBefore = instance.getSnapshot().entries;

    // Delivered as live output, not history: a history frame whose
    // `startOffset` differs from the requested one is a FRESH load, which
    // refreshes the array unconditionally and would mask what this case is
    // about.
    const second = ndjson({ v: 1, type: 'context-usage', promptTokens: 4300, estimated: false });
    ws!.simulateMessage(outputMessage(second, first.length + second.length));
    await flush();

    // The reading itself still reaches the snapshot -- `patch()` publishes
    // that independently, which is why returning false here costs nothing.
    expect(instance.getSnapshot().contextUsage).toEqual({ promptTokens: 4300, estimated: false });
    expect(instance.getSnapshot().entries).toBe(entriesBefore);
  });

  it('ignores sdk-session-id without creating a chat entry (SDK Engine Phase 1, no client UI surface yet)', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3sdk', 'w3sdk');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'sdk-session-id', sdkSessionId: 'sdk-sess-1' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    expect(instance.getSnapshot().entries).toHaveLength(0);
  });

  it('folds context-compacted into a context-compacted chat entry, carrying source and summary', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s3g', 'w3g');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({
      v: 1,
      type: 'context-compacted',
      source: 'auto',
      summary: 'summary of the conversation so far',
    });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const snapshot = instance.getSnapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      kind: 'context-compacted',
      source: 'auto',
      summary: 'summary of the conversation so far',
    });
  });

  it('folds a context-compacted with NO summary, leaving the field absent rather than empty', async () => {
    // `summary` is optional on the wire because an engine may have none.
    // Absent must stay absent: the view renders a plain boundary line for it,
    // and an injected empty string would render an expandable disclosure onto
    // nothing.
    const instance = getOrCreateEmbeddedAgentWorker('s3g2', 'w3g2');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'context-compacted', source: 'manual' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entry = instance.getSnapshot().entries[0];
    expect(entry).toMatchObject({ kind: 'context-compacted', source: 'manual' });
    expect('summary' in entry).toBe(false);
  });

  it('REGRESSION (#1401): still folds a LEGACY context-handoff row from a historical stream', async () => {
    // No engine emits `context-handoff` any more, but transcripts written
    // before the compaction swap contain these rows and replay them on every
    // history load. Dropping the fold (or the entry kind) would render an old
    // transcript with a silent hole where a real boundary was. The fixture is
    // deliberately a whole historical stream rather than the single event, so
    // it also pins that the surrounding rows still land in the right order.
    const instance = getOrCreateEmbeddedAgentWorker('s3g3', 'w3g3');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson(
      { v: 1, type: 'user-message', id: 'm1', text: 'before the handoff' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply before' },
      { v: 1, type: 'context-handoff', distillation: 'summary of the conversation so far' },
      { v: 1, type: 'user-message', id: 'm2', text: 'after the handoff' },
    );
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(4);
    expect(entries[2]).toMatchObject({
      kind: 'context-handoff',
      distillation: 'summary of the conversation so far',
    });
    expect(entries[3]).toMatchObject({ kind: 'user-message', text: 'after the handoff' });
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

  it('carries an exited row `reason: evicted` through onto the entry (idle eviction)', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s5-evicted', 'w5-evicted');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'exited', code: 0, reason: 'evicted' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'exited', code: 0, reason: 'evicted' });
  });

  it('leaves `reason` ABSENT on an exited row written by a server older than idle eviction', async () => {
    // Absence is a real wire state (a persisted transcript predating the
    // field), and the store must not translate it into `null` or a default
    // like `'managed'` -- the view distinguishes the two by an equality test
    // on `'evicted'`, so a store-side default would be a lie it has to undo.
    const instance = getOrCreateEmbeddedAgentWorker('s5-noreason', 'w5-noreason');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'exited', code: 0 });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Extract<EmbeddedAgentChatEntry, { kind: 'exited' }>;
    expect(entry.kind).toBe('exited');
    expect(Object.prototype.hasOwnProperty.call(entry, 'reason')).toBe(false);
    expect(entry.reason).toBeUndefined();
  });

  describe('currentExit (#1455) -- single-writer current-state field', () => {
    it('initializes to null (no affordance) before any exited/ready event has been observed', () => {
      const instance = getOrCreateEmbeddedAgentWorker('s5c-init', 'w5c-init');
      expect(instance.getSnapshot().currentExit).toBeNull();
    });

    it('sets currentExit from the exited event, verbatim including an absent reason', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s5c-set', 'w5c-set');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const data = ndjson({ v: 1, type: 'exited', code: 3 });
      ws!.simulateMessage(historyMessage(data, data.length));
      await flush();

      const currentExit = instance.getSnapshot().currentExit;
      expect(currentExit).not.toBeNull();
      expect(currentExit?.code).toBe(3);
      expect(Object.prototype.hasOwnProperty.call(currentExit, 'reason')).toBe(false);
    });

    it('sets currentExit with reason carried through verbatim (e.g. evicted)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s5c-evicted', 'w5c-evicted');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const data = ndjson({ v: 1, type: 'exited', code: 0, reason: 'evicted' });
      ws!.simulateMessage(historyMessage(data, data.length));
      await flush();

      expect(instance.getSnapshot().currentExit).toEqual({ code: 0, reason: 'evicted' });
    });

    it('clears currentExit back to null on the next `ready` event (fresh incarnation)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('s5c-clear', 'w5c-clear');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const exitedData = ndjson({ v: 1, type: 'exited', code: 1 });
      ws!.simulateMessage(historyMessage(exitedData, exitedData.length));
      await flush();
      expect(instance.getSnapshot().currentExit).not.toBeNull();

      const readyData = ndjson({ v: 1, type: 'ready' });
      ws!.simulateMessage(outputMessage(readyData, exitedData.length + readyData.length));
      await flush();

      expect(instance.getSnapshot().currentExit).toBeNull();
    });

    it('reflects only the LATEST exited event when several exited rows are replayed, not any accumulation of the historical rows', async () => {
      // #1455 regression pin at the store layer: currentExit must be a
      // current-state overwrite, never a derivation from `entries`. Two
      // historical exits followed by a fresh 'ready' must leave
      // currentExit === null, exactly as if only one exit had ever
      // happened -- the count of historical `exited` rows is irrelevant.
      const instance = getOrCreateEmbeddedAgentWorker('s5c-multi', 'w5c-multi');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const data = ndjson(
        { v: 1, type: 'exited', code: 1 },
        { v: 1, type: 'exited', code: 2 },
        { v: 1, type: 'ready' },
      );
      ws!.simulateMessage(historyMessage(data, data.length));
      await flush();

      const entries = instance.getSnapshot().entries;
      expect(entries.filter((e) => e.kind === 'exited')).toHaveLength(2);
      expect(instance.getSnapshot().currentExit).toBeNull();
    });

    it('toggles back and forth across a full exited -> ready -> exited cycle, never leaving a stale value from the first exit', async () => {
      // PR review gap: every other test in this block ends the sequence in
      // ONE state (currently exited, or currently null-after-one-clear).
      // This is the one that actually exercises BOTH handlers toggling in
      // sequence -- a stale-value bug in either direction (the 'ready'
      // handler failing to clear, or the second 'exited' handler failing to
      // re-set) is only observable across a full cycle, not a single
      // set-then-clear.
      const instance = getOrCreateEmbeddedAgentWorker('s5c-cycle', 'w5c-cycle');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      let offset = 0;
      const firstExited = ndjson({ v: 1, type: 'exited', code: 1 });
      ws!.simulateMessage(outputMessage(firstExited, (offset += firstExited.length)));
      await flush();
      expect(instance.getSnapshot().currentExit).toEqual({ code: 1 });

      const readyData = ndjson({ v: 1, type: 'ready' });
      ws!.simulateMessage(outputMessage(readyData, (offset += readyData.length)));
      await flush();
      expect(instance.getSnapshot().currentExit).toBeNull();

      // Different code from the first exit so a stale `{ code: 1 }` left
      // over from the first 'exited' handler is distinguishable from a
      // correct re-set.
      const secondExited = ndjson({ v: 1, type: 'exited', code: 2 });
      ws!.simulateMessage(outputMessage(secondExited, (offset += secondExited.length)));
      await flush();
      expect(instance.getSnapshot().currentExit).toEqual({ code: 2 });
    });

    it('clears currentExit on an epoch bump (worker restarted server-side), before any new ready/exited arrives for the new incarnation', async () => {
      // CodeRabbit review finding on this PR: `currentExit` is
      // worker-LIVENESS state by its own definition (the worker's CURRENT
      // exit state), same as `activityState` -- so it must be cleared in
      // `beginEpochReset` (the epoch-REPLACEMENT path), not left to survive
      // until the new incarnation's own 'ready'/'exited' event folds in.
      // Without this, a superseded incarnation's exit state drives a stale
      // Restart affordance for a worker that no longer exists -- the same
      // defect class #1480 fixed the same day for `activityState` in this
      // same function.
      const instance = getOrCreateEmbeddedAgentWorker('s5c-epoch', 'w5c-epoch');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      // Establish epoch 1 and a live exit within it.
      const exitedData = ndjson({ v: 1, type: 'exited', code: 1 });
      ws!.simulateMessage(historyMessage(exitedData, exitedData.length, 0, 1));
      await flush();
      expect(instance.getSnapshot().currentExit).toEqual({ code: 1 });

      // A larger epoch means the worker restarted server-side -- this
      // message itself carries no 'ready'/'exited' event, so any clearing
      // observed here can only come from beginEpochReset itself, not from
      // folding a new incarnation's own liveness event.
      const bumpData = ndjson({ v: 1, type: 'user-message', id: 'u-bump', text: 'after restart' });
      ws!.simulateMessage(outputMessage(bumpData, bumpData.length, 2));
      await flush();

      expect(instance.getSnapshot().currentExit).toBeNull();
    });
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

  it('folds a user-message carrying a `notification` field (Issue #1351: system-originated internal notification)', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s5c', 'w5c');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({
      v: 1,
      type: 'user-message',
      id: 'u1',
      text: '[internal:message] timestamp=2026-08-18T00:00:00.000Z source=session from=other-session summary="Message from session X"',
      notification: { kind: 'internal-message', summary: 'Message from session X' },
    });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'user-message',
      id: 'u1',
      notification: { kind: 'internal-message', summary: 'Message from session X' },
    });
  });

  it('a user-message with NO `notification` field folds into an entry where the key is genuinely absent, not merely undefined', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s5d', 'w5d');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    const data = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'a real human message' });
    ws!.simulateMessage(historyMessage(data, data.length));
    await flush();

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect('notification' in entries[0]).toBe(false);
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

  it('resets activityState to unknown on an epoch bump, releasing a stale active gate', async () => {
    const instance = getOrCreateEmbeddedAgentWorker('s10b', 'w10b');
    const ws = MockWebSocket.getLastInstance();
    ws!.simulateOpen();

    // Establish epoch 1 and drive activityState to 'active' (worker mid-turn).
    const data1 = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'before restart' });
    ws!.simulateMessage(historyMessage(data1, data1.length, 0, 1));
    await flush();
    ws!.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    await flush();
    expect(instance.getSnapshot().activityState).toBe('active');

    // A larger epoch means the worker restarted server-side; the discarded
    // incarnation's last-known activityState must not survive the reset and
    // keep gating the composer for a worker that no longer exists.
    const data2 = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'after restart' });
    ws!.simulateMessage(outputMessage(data2, data2.length, 2));
    await flush();

    expect(instance.getSnapshot().activityState).toBe('unknown');
  });

  it('preserves an active activityState across a same-epoch fresh load (server prune / resync), unlike a genuine epoch bump', async () => {
    // Regression pin for a CodeRabbit-caught defect: resetChatState() is
    // shared by beginEpochReset (a genuine incarnation change -- see the
    // epoch-bump test above) AND applyBytes's same-epoch `isFresh` branch
    // (the server pruned/evicted its buffer, or a resync's fresh load --
    // the SAME live worker incarnation, possibly still mid-turn). An
    // earlier fix wrongly reset activityState inside resetChatState()
    // itself, which meant a worker that was genuinely 'active' got its
    // activityState wiped to 'unknown' by a SAME-epoch fresh load with no
    // accompanying `activity` message to re-declare it -- releasing
    // MessagePanel's stale-active send-gate while the turn was still in
    // progress. activityState must only be reset in beginEpochReset, where
    // the incarnation has actually changed.
    const instance = getOrCreateEmbeddedAgentWorker('s10c', 'w10c');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();

    // Establish epoch 1 and drive activityState to 'active' (worker mid-turn).
    const initialData = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'first' });
    ws1!.simulateMessage(historyMessage(initialData, initialData.length, 0, 1));
    await flush();
    ws1!.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    await flush();
    expect(instance.getSnapshot().activityState).toBe('active');

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
    // sends a fresh payload starting at 0. This hits applyBytes's `isFresh`
    // branch (startOffset !== requestedFromOffset) WITHOUT bumping the
    // epoch -- acceptEpoch short-circuits to true for `epoch === this.epoch`
    // and never calls beginEpochReset here.
    const prunedData = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'second (post-prune)' });
    ws2!.simulateMessage(historyMessage(prunedData, prunedData.length, 0, 1));
    await flush();

    // The worker incarnation never changed -- it may still be genuinely
    // mid-turn -- so activityState must survive this reset unchanged.
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

  it('sendUserMessage still produces a valid clientMessageId when crypto.randomUUID is unavailable (non-secure context, #1345)', () => {
    // Simulate non-secure context: crypto exists but without randomUUID
    // (same technique as lib/__tests__/id.test.ts's "non-secure context
    // fallback" block). This proves the call site routes through
    // generateClientId()'s guarded fallback rather than calling
    // crypto.randomUUID() directly.
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
      writable: true,
      configurable: true,
    });

    try {
      const instance = getOrCreateEmbeddedAgentWorker('s14b', 'w14b');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      expect(() => {
        instance.sendUserMessage('hello agent').catch(() => {});
      }).not.toThrow();

      const sent = (
        lastSentMessages(ws!) as { type: string; text?: string; clientMessageId?: string }[]
      ).find((m) => m.type === 'embedded-user-message')!;
      expect(typeof sent.clientMessageId).toBe('string');
      expect(sent.clientMessageId?.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    }
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

  describe('Transcript Restore (#1123)', () => {
    it('sets restoring/restoredMessageCount on a restore-info message received before any ready event', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r1', 'w1');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      ws!.simulateMessage(restoreInfoMessage(1, 5, []));

      const snapshot = instance.getSnapshot();
      expect(snapshot.restoring).toBe(true);
      expect(snapshot.restoredMessageCount).toBe(5);
    });

    it('keeps a restoredMessageCount of 0 as 0, not null (#1428: 0 is a real wire value now)', () => {
      // Since #1428 the count excludes the synthetic system prompt, so an
      // activated-but-never-spoken-to worker legitimately reports 0. The
      // snapshot must carry that 0 through verbatim: `null` means "no
      // restore-info accepted this epoch", a different fact, and any falsy
      // coercion (`count || null`) would collapse the two and re-hide the
      // very state the fix made reachable.
      //
      // Mutation reach (measured): breaks under "store drops the field"
      // (reading the pre-rename `message.messageCount`, which yields
      // `undefined`).
      const instance = getOrCreateEmbeddedAgentWorker('r1-zero', 'w1-zero');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      ws!.simulateMessage(restoreInfoMessage(1, 0, []));

      const snapshot = instance.getSnapshot();
      expect(snapshot.restoredMessageCount).toBe(0);
      expect(snapshot.restoring).toBe(true);
    });

    it('clears restoring back to false when a completed:true restore-info push arrives (server-authoritative, #1205)', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r2', 'w2');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      ws!.simulateMessage(restoreInfoMessage(1, 5, [], false));
      expect(instance.getSnapshot().restoring).toBe(true);

      // The server sends a FRESH restore-info push with completed: true the
      // moment the new incarnation's `ready` event is observed server-side.
      // A successful restore does not mint a new epoch, so this arrives on
      // the SAME epoch.
      ws!.simulateMessage(restoreInfoMessage(1, 5, [], true));

      const snapshot = instance.getSnapshot();
      expect(snapshot.restoring).toBe(false);
      // restoredMessageCount is not required to be cleared on completion -- it stays
      // at its last-known value from the most recently accepted restore-info.
      expect(snapshot.restoredMessageCount).toBe(5);
    });

    it('shows restoring even when a ready event for the same epoch was already folded before restore-info arrives (Issue #1205 real WS-frame-order regression)', async () => {
      // Reproduces the exact race captured from a real reconnect-after-crash:
      // a successful restore does NOT mint a new epoch, so a `ready` event
      // folded via history/output (e.g. this tab was live through a prior
      // incarnation, or history replayed `ready` before restore-info for the
      // SAME epoch arrived) must NOT suppress the restoring banner for a
      // restore-info that arrives afterward for that same epoch. Under the
      // old client-local `readyObservedThisEpoch` derivation this case was
      // structurally broken: `readyObservedThisEpoch` was already `true` by
      // the time `applyRestoreInfo`'s guard ran, so `restoring` was never
      // set. The fix reads `restoring` directly off the message's own
      // `completed` field, ignoring any prior `ready` fold.
      const instance = getOrCreateEmbeddedAgentWorker('r8', 'w8');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      const readyData = ndjson({ v: 1, type: 'ready' });
      ws!.simulateMessage(historyMessage(readyData, readyData.length, 0, 1));
      await flush();

      ws!.simulateMessage(restoreInfoMessage(1, 3, [], false));
      expect(instance.getSnapshot().restoring).toBe(true);

      ws!.simulateMessage(restoreInfoMessage(1, 3, [], true));
      expect(instance.getSnapshot().restoring).toBe(false);
    });

    it('pushes exactly one restore-repair entry when repairedToolCallIds is non-empty', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r3', 'w3');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      ws!.simulateMessage(restoreInfoMessage(1, 5, ['call-1', 'call-2']));

      const entries = instance.getSnapshot().entries;
      const repairEntries = entries.filter((e) => e.kind === 'restore-repair');
      expect(repairEntries).toHaveLength(1);
      expect(repairEntries[0]).toMatchObject({ kind: 'restore-repair', toolCallIds: ['call-1', 'call-2'] });
    });

    it('does not push a duplicate restore-repair entry when the same restore-info is re-delivered without a reset in between (bootstrap re-delivery on a plain reconnect)', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r4', 'w4');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      ws!.simulateMessage(restoreInfoMessage(1, 5, ['call-1']));
      ws!.simulateMessage(restoreInfoMessage(1, 5, ['call-1']));

      const repairEntries = instance.getSnapshot().entries.filter((e) => e.kind === 'restore-repair');
      expect(repairEntries).toHaveLength(1);
    });

    it('re-renders the restore-repair entry after a fresh reconnect that wiped entries (resetChatState fired)', async () => {
      const instance = getOrCreateEmbeddedAgentWorker('r5', 'w5');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      ws!.simulateMessage(restoreInfoMessage(1, 5, ['call-1']));
      expect(
        instance.getSnapshot().entries.filter((e) => e.kind === 'restore-repair'),
      ).toHaveLength(1);

      // A genuine epoch bump (worker restarted server-side) triggers
      // resetChatState via beginEpochReset. Unlike a stale-epoch message,
      // this SAME message is the new epoch's first evidence -- it must be
      // applied against the freshly-reset state immediately, in a single
      // call, rather than being discarded on the assumption a later
      // bootstrap redelivery will resend it on this same connection (it
      // won't -- redelivery only happens on a fresh WS connection's onOpen).
      ws!.simulateMessage(restoreInfoMessage(2, 5, ['call-1']));
      await flush();

      const repairEntries = instance.getSnapshot().entries.filter((e) => e.kind === 'restore-repair');
      expect(repairEntries).toHaveLength(1);
    });

    it('drops a restore-info from a stale/superseded epoch without affecting restoring or entries', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r6', 'w6');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();

      // Establish epoch 2 as current via a genuine bump.
      ws!.simulateMessage(restoreInfoMessage(1, 3, []));
      ws!.simulateMessage(restoreInfoMessage(2, 3, []));
      ws!.simulateMessage(restoreInfoMessage(2, 7, ['call-9']));

      const beforeSnapshot = instance.getSnapshot();
      expect(beforeSnapshot.restoredMessageCount).toBe(7);

      // A stale, smaller epoch (a slow-arriving fast-path push racing a
      // subsequent restart) must be dropped entirely by acceptEpoch.
      ws!.simulateMessage(restoreInfoMessage(1, 999, ['stale-call']));

      const afterSnapshot = instance.getSnapshot();
      expect(afterSnapshot.restoredMessageCount).toBe(7);
      expect(afterSnapshot.restoring).toBe(beforeSnapshot.restoring);
      expect(afterSnapshot.entries).toEqual(beforeSnapshot.entries);
    });
  });
});

// Type-level smoke check: entries must be a discriminated union covering all
// kinds this file exercises (compile-time guard against a future kind being
// dropped from the store's exported type).
function _typeCheck(entry: EmbeddedAgentChatEntry): string {
  return entry.kind;
}
void _typeCheck;

describe('embedded-agent-store — Transcript Restore R1 (#1410)', () => {
  // Same fixture wiring as the main suite above (mock socket + a location
  // shim the store reads when building its URL), repeated rather than shared
  // because this is a sibling top-level describe.
  let restoreWebSocket2: () => void;
  let originalLocation2: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket2 = installMockWebSocket();
    originalLocation2 = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket2();
    if (originalLocation2) {
      Object.defineProperty(window, 'location', originalLocation2);
    }
  });

  describe('sdkResumed is carried through three-valued', () => {
    it('is undefined before any restore-info arrives', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r1', 'w1');
      MockWebSocket.getLastInstance()!.simulateOpen();
      expect(instance.getSnapshot().sdkResumed).toBeUndefined();
    });

    it('stays undefined when the message omits the field (the openai-api case)', () => {
      // The load-bearing one: normalising absence to `false` anywhere along
      // this path would put a permanent divergence notice on every worker of
      // the other engine.
      const instance = getOrCreateEmbeddedAgentWorker('r2', 'w2');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(restoreInfoMessage(1, 3, [], true));
      expect(instance.getSnapshot().sdkResumed).toBeUndefined();
    });

    it('is true when the message says true', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r3', 'w3');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(restoreInfoMessage(1, 3, [], true, true));
      expect(instance.getSnapshot().sdkResumed).toBe(true);
    });

    it('is false when the message says false', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r4', 'w4');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(restoreInfoMessage(1, 3, [], true, false));
      expect(instance.getSnapshot().sdkResumed).toBe(false);
    });

    it('follows the server correcting true down to false on a re-push', () => {
      // The residual path: the server reported an intended resume optimistically
      // at activation, then the subprocess said it did not take.
      const instance = getOrCreateEmbeddedAgentWorker('r5', 'w5');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(restoreInfoMessage(1, 3, [], false, true));
      expect(instance.getSnapshot().sdkResumed).toBe(true);

      ws!.simulateMessage(restoreInfoMessage(1, 3, [], false, false));
      expect(instance.getSnapshot().sdkResumed).toBe(false);
    });

    it('resets to undefined on a newer epoch', () => {
      const instance = getOrCreateEmbeddedAgentWorker('r6', 'w6');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(restoreInfoMessage(1, 3, [], true, false));
      expect(instance.getSnapshot().sdkResumed).toBe(false);

      // A newer epoch is a different incarnation; carrying the old answer
      // forward would describe a restore that did not happen.
      ws!.simulateMessage(restoreInfoMessage(2, 0, [], true));
      expect(instance.getSnapshot().sdkResumed).toBeUndefined();
    });
  });

  describe('turn-interrupted', () => {
    it('folds a turn-interrupted event into a marker row', () => {
      const instance = getOrCreateEmbeddedAgentWorker('t1', 'w1');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(
        outputMessage(ndjson({ v: 1, type: 'turn-interrupted', turnId: 'u9' }), 100, 1),
      );

      const entries = instance.getSnapshot().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'turn-interrupted', turnId: 'u9' });
    });

    it('keys the row by turnId so a replayed stream does not duplicate it', () => {
      // The whole stream is replayed on every reconnect; a counter-based key
      // would render one marker per replay.
      const instance = getOrCreateEmbeddedAgentWorker('t2', 'w2');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(outputMessage(ndjson({ v: 1, type: 'turn-interrupted', turnId: 'u9' }), 100, 1));
      const [first] = instance.getSnapshot().entries;
      expect(first.key).toBe('turn-interrupted-u9');
    });

    it('is a distinct kind from turn-error', () => {
      // Nothing errored -- a process went away. Collapsing them would render
      // an engine-reported failure the engine never reported.
      const instance = getOrCreateEmbeddedAgentWorker('t3', 'w3');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(outputMessage(ndjson({ v: 1, type: 'turn-interrupted', turnId: 'u9' }), 100, 1));
      expect(instance.getSnapshot().entries.some((e) => e.kind === 'turn-error')).toBe(false);
    });
  });

  describe('sdk-resume-failed', () => {
    it('produces no chat row (it is server bookkeeping, not something the user reads)', () => {
      // What the user sees about a refused resume is the engine's own
      // turn-error plus the notice; this event must not add a second voice.
      const instance = getOrCreateEmbeddedAgentWorker('s1', 'w1');
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(
        outputMessage(
          ndjson({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: 'sess-gone', reason: 'refused' }),
          120,
          1,
        ),
      );
      expect(instance.getSnapshot().entries).toHaveLength(0);
    });
  });
});

describe('embedded-agent-store — Transcript Restore failure form (#1449)', () => {
  // Same fixture wiring as the two suites above, repeated rather than shared
  // because this is a sibling top-level describe.
  let restoreWebSocket3: () => void;
  let originalLocation3: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket3 = installMockWebSocket();
    originalLocation3 = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket3();
    if (originalLocation3) {
      Object.defineProperty(window, 'location', originalLocation3);
    }
  });

  // R3 (#1447 stage 4) supersedes the ORIGINAL version of this test, which
  // asserted `entries`/`restoredMessageCount`/`restoring` were left
  // UNTOUCHED by applyRestoreFailure -- as this file's own git history shows
  // (#1473), that was correct ONLY for the reset-only mechanism it was
  // written against, where a real restore failure always bumped the epoch
  // and `resetChatState` had already cleared those fields before this
  // handler ever ran. R1 inverts that on the PRIMARY route: a restore
  // failure no longer bumps the epoch, so `applyRestoreFailure` is now the
  // SOLE clearer of `restoredMessageCount`/`restoring` there, while
  // `entries` -- the field the original pin also called "untouched" -- must
  // now be explicitly PRESERVED (C1), not merely left alone by accident of
  // never having run. Split into two tests below, one per route, per the
  // AC's "the fallback path still bumps the epoch, so BOTH exclusivity
  // routes need pins."
  //
  // Mutation reach (measured 2026-08-30): commenting out the
  // `message.failed === true` branch in embedded-agent-store.ts's
  // `case 'restore-info':` handler (collapsing to an unconditional
  // `applyRestoreInfo(message.restoredMessageCount, ...)` call) makes both
  // tests below, and the "resets ... on a genuine epoch bump" tests further
  // down, fail with `TypeError: undefined is not an object (evaluating
  // 'repairedToolCallIds.length')` -- a real failure-shaped message has none
  // of those fields, so applyRestoreInfo throws when fed one. Confirmed by
  // temporarily applying the mutation, running `bun test`, and restoring.
  it('R3 PRIMARY (in-band) route: same epoch, clears restoredMessageCount/restoring, PRESERVES entries', () => {
    const instance = getOrCreateEmbeddedAgentWorker('f1', 'w1');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    // Establish pre-existing state via a SUCCESS form plus a real folded
    // chat entry, same epoch -- entries must be non-empty for "preserved"
    // to be a meaningful assertion (an empty array is preserved trivially).
    ws.simulateMessage(restoreInfoMessage(1, 5, [], false));
    ws.simulateMessage(
      outputMessage(ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }), 100, 1),
    );
    const before = instance.getSnapshot();
    expect(before.restoredMessageCount).toBe(5);
    expect(before.restoring).toBe(true);
    expect(before.restoreFailed).toBe(false);
    expect(before.entries).toHaveLength(1);

    // A failure form arriving on the SAME epoch, with preservation:
    // 'in-band', is the PRIMARY route: no epoch bump, so resetChatState
    // never runs and this handler is the sole clearer of the
    // incarnation-scoped fields -- entries must survive untouched.
    ws.simulateMessage(restoreFailureMessage(1, true, 'in-band'));

    const after = instance.getSnapshot();
    expect(after.restoreFailed).toBe(true);
    expect(after.sdkResumed).toBe(true);
    expect(after.preservation).toBe('in-band');
    expect(after.restoredMessageCount).toBeNull();
    expect(after.restoring).toBe(false);
    expect(after.entries).toEqual(before.entries);
    expect(after.entries).toHaveLength(1);
  });

  it('R3 FALLBACK (sidecar/lost) route: epoch bump has already emptied entries via resetChatState; applyRestoreFailure is a no-op on it', () => {
    const instance = getOrCreateEmbeddedAgentWorker('f1b', 'w1b');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    ws.simulateMessage(restoreInfoMessage(1, 5, [], false));
    ws.simulateMessage(
      outputMessage(ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }), 100, 1),
    );
    expect(instance.getSnapshot().entries).toHaveLength(1);

    // A failure form on a NEWER epoch is the FALLBACK route: acceptEpoch
    // synchronously runs beginEpochReset -> resetChatState BEFORE this
    // message is applied (see the `restore-info` case's own comment on
    // "Applying against whatever epoch we ended up on"), wiping entries to
    // [] and restoredMessageCount/restoring back to their epoch-reset
    // defaults. applyRestoreFailure's own clearing is redundant-but-harmless
    // here, and not touching entries is correct -- there is nothing left to
    // preserve or clobber.
    ws.simulateMessage(restoreFailureMessage(2, true, 'sidecar'));

    const after = instance.getSnapshot();
    expect(after.restoreFailed).toBe(true);
    expect(after.preservation).toBe('sidecar');
    expect(after.restoredMessageCount).toBeNull();
    expect(after.restoring).toBe(false);
    expect(after.entries).toEqual([]);
  });

  it('resets restoreFailed back to false on a genuine epoch bump (resetChatState)', () => {
    const instance = getOrCreateEmbeddedAgentWorker('f2', 'w2');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    ws.simulateMessage(restoreFailureMessage(1, true, 'in-band'));
    expect(instance.getSnapshot().restoreFailed).toBe(true);

    // A genuine epoch bump (a NEW incarnation's own restore attempt) must
    // clear restoreFailed BEFORE re-declaring for the new incarnation.
    // applyRestoreInfo never itself writes restoreFailed, so the only way
    // this can read false here is via resetChatState's reset -- if that
    // reset were dropped, the stale `true` from epoch 1 would survive.
    ws.simulateMessage(restoreInfoMessage(2, 3, [], false));
    expect(instance.getSnapshot().restoreFailed).toBe(false);
  });

  it('resets preservation back to undefined on a genuine epoch bump (resetChatState)', () => {
    const instance = getOrCreateEmbeddedAgentWorker('f2b', 'w2b');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    ws.simulateMessage(restoreFailureMessage(1, true, 'sidecar'));
    expect(instance.getSnapshot().preservation).toBe('sidecar');

    // Same reasoning as restoreFailed above: a genuine epoch bump must clear
    // preservation BEFORE the new incarnation's own restore-info re-declares
    // it, since a stale preservation value from a superseded incarnation
    // would otherwise condition the banner on the WRONG restore attempt.
    ws.simulateMessage(restoreInfoMessage(2, 3, [], false));
    expect(instance.getSnapshot().preservation).toBeUndefined();
  });

  it('never sets restoreFailed on a success-form restore-info message', () => {
    const instance = getOrCreateEmbeddedAgentWorker('f3', 'w3');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage(restoreInfoMessage(1, 5, [], true, false));
    expect(instance.getSnapshot().restoreFailed).toBe(false);
  });

  it('never sets preservation on a success-form restore-info message', () => {
    const instance = getOrCreateEmbeddedAgentWorker('f3b', 'w3b');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage(restoreInfoMessage(1, 5, [], true, false));
    expect(instance.getSnapshot().preservation).toBeUndefined();
  });

  it('carries an absent preservation through verbatim (pre-stage-4 server) rather than normalising it', () => {
    const instance = getOrCreateEmbeddedAgentWorker('f4', 'w4');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();
    // No third argument: the wire message omits `preservation` entirely,
    // exactly like a pre-stage-4 server would.
    ws.simulateMessage(restoreFailureMessage(1, true));
    const snapshot = instance.getSnapshot();
    expect(snapshot.restoreFailed).toBe(true);
    expect(snapshot.preservation).toBeUndefined();
  });

  it('preserves a declared restore failure across a same-epoch fresh load (server prune / resync), unlike a genuine epoch bump', async () => {
    // Regression pin for a CodeRabbit-caught defect (Issue #1447 stage 4,
    // upgraded to MEDIUM): resetChatState() is shared by beginEpochReset (a
    // genuine incarnation change) AND applyBytes's same-epoch `isFresh`
    // branch (requestHistory() fires on EVERY WebSocket reconnect --
    // including a plain network blip or tab wake -- not just a worker
    // restart). resetChatState() used to unconditionally clear
    // restoreFailed/preservation, so a PRIMARY-route (in-band) restore
    // failure that was correctly displayed silently lost its banner on the
    // very next ordinary reconnect, even though the worker never restarted
    // and the divergence was still real -- defeating C2 ("a declared
    // divergence must not silently disappear"). restoreFailed/preservation
    // must only be reset in beginEpochReset, where the incarnation has
    // actually changed, mirroring the activityState separation pinned by
    // "preserves an active activityState across a same-epoch fresh load"
    // above.
    const instance = getOrCreateEmbeddedAgentWorker('f5', 'w5');
    const ws1 = MockWebSocket.getLastInstance();
    ws1!.simulateOpen();

    // Establish epoch 1 with a PRIMARY-route (in-band) restore failure.
    const initialData = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'first' });
    ws1!.simulateMessage(historyMessage(initialData, initialData.length, 0, 1));
    await flush();
    ws1!.simulateMessage(restoreFailureMessage(1, true, 'in-band'));
    await flush();
    expect(instance.getSnapshot().restoreFailed).toBe(true);
    expect(instance.getSnapshot().preservation).toBe('in-band');

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
    // sends a fresh payload starting at 0. This hits applyBytes's `isFresh`
    // branch (startOffset !== requestedFromOffset) WITHOUT bumping the
    // epoch -- acceptEpoch short-circuits to true for `epoch === this.epoch`
    // and never calls beginEpochReset here. A `history` response never
    // carries a fresh `restore-info`, so nothing is coming to re-declare
    // the failure.
    const prunedData = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'second (post-prune)' });
    ws2!.simulateMessage(historyMessage(prunedData, prunedData.length, 0, 1));
    await flush();

    // The worker incarnation never changed -- the declared divergence must
    // survive this reset unchanged.
    expect(instance.getSnapshot().restoreFailed).toBe(true);
    expect(instance.getSnapshot().preservation).toBe('in-band');
  });

  it('publishes a genuine epoch reset as ONE coherent snapshot: never observes entries already cleared while restoreFailed/preservation still carry the stale pre-reset declaration (#1503)', async () => {
    // Regression pin for a CodeRabbit-caught defect introduced by the fix
    // above (Issue #1447 stage 4 / #1503): `beginEpochReset` used to call
    // `resetChatState()` (its own `patch()` -- entries: [], restoring:
    // false, ...) and THEN a SEPARATE `this.patch({ restoreFailed: false,
    // preservation: undefined, ... })`. `patch()` notifies listeners
    // synchronously, so a subscriber's listener could run BETWEEN the two
    // calls and observe an impossible combination: entries already emptied
    // by the first patch, but restoreFailed/preservation still holding the
    // STALE declaration from before the reset -- self-contradictory,
    // because `preservation: 'in-band'` means "the earlier transcript is
    // still shown above" while entries had, at that exact snapshot, just
    // been emptied by the very reset that intermediate state claims didn't
    // happen. The fix merges both into a single `patch()` call inside
    // `resetChatState` so the whole epoch-reset update reaches listeners in
    // one publish.
    const instance = getOrCreateEmbeddedAgentWorker('f6', 'w6');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    // Establish epoch 1 with a real chat entry AND a PRIMARY-route (in-band)
    // declared restore failure -- both must be true beforehand, since the
    // impossible intermediate snapshot is only representable when entries
    // is non-empty and restoreFailed/preservation are already set.
    const initialData = ndjson({ v: 1, type: 'user-message', id: 'u1', text: 'hello' });
    ws.simulateMessage(historyMessage(initialData, initialData.length, 0, 1));
    await flush();
    ws.simulateMessage(restoreFailureMessage(1, true, 'in-band'));
    await flush();
    const before = instance.getSnapshot();
    expect(before.entries).toHaveLength(1);
    expect(before.restoreFailed).toBe(true);
    expect(before.preservation).toBe('in-band');

    // Subscribe AFTER establishing the pre-reset state, so only the
    // upcoming epoch reset's own publish(es) are captured.
    const observed: Array<{ entriesLength: number; restoreFailed: boolean }> = [];
    instance.subscribe(() => {
      const snap = instance.getSnapshot();
      observed.push({ entriesLength: snap.entries.length, restoreFailed: snap.restoreFailed });
    });

    // A genuine epoch bump (a NEW incarnation, mirroring the
    // `currentExit`/`activityState` epoch-bump tests above) synchronously
    // runs beginEpochReset inside acceptEpoch.
    const bumpData = ndjson({ v: 1, type: 'user-message', id: 'u2', text: 'after restart' });
    ws.simulateMessage(outputMessage(bumpData, bumpData.length, 2));
    await flush();

    expect(observed.length).toBeGreaterThan(0);
    for (const snap of observed) {
      // The impossible combination: entries just cleared by the reset, but
      // restoreFailed still true from before it -- never observable.
      expect(snap.entriesLength === 0 && snap.restoreFailed === true).toBe(false);
    }

    // Sanity: the reset did complete by the end (both cleared together).
    const after = instance.getSnapshot();
    expect(after.entries).toEqual([]);
    expect(after.restoreFailed).toBe(false);
    expect(after.preservation).toBeUndefined();
  });
});

describe('embedded-agent-store — Transcript Restore stage 4 markers (#1447)', () => {
  // Same fixture wiring as the sibling suites above, repeated rather than
  // shared because this is a sibling top-level describe.
  let restoreWebSocket4: () => void;
  let originalLocation4: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket4 = installMockWebSocket();
    originalLocation4 = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket4();
    if (originalLocation4) {
      Object.defineProperty(window, 'location', originalLocation4);
    }
  });

  it('R2: folds a restore-failure-boundary event into a restore-failure-boundary marker row', () => {
    const instance = getOrCreateEmbeddedAgentWorker('m1', 'w1');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    ws.simulateMessage(
      outputMessage(ndjson({ v: 1, type: 'restore-failure-boundary' }), 100, 1),
    );

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'restore-failure-boundary' });
  });

  it('R6: folds a restore-failure-declaration event into a restore-failure-declaration marker row', () => {
    const instance = getOrCreateEmbeddedAgentWorker('m2', 'w2');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    ws.simulateMessage(
      outputMessage(ndjson({ v: 1, type: 'restore-failure-declaration' }), 100, 1),
    );

    const entries = instance.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'restore-failure-declaration' });
  });

  it('R6: unlike turn-interrupted, does NOT close an open thinking entry (restore-transparent, not an orphaned-turn signal)', () => {
    // A restore-failure-declaration row is a quiet notification about a
    // divergence between the SDK's own memory and the display -- it must not
    // be treated as "the incarnation that owned this turn is gone" the way
    // turn-interrupted/exited/fatal are. Folding one while a thinking entry
    // is still streaming must leave that entry's `streaming` flag alone.
    const instance = getOrCreateEmbeddedAgentWorker('m3', 'w3');
    const ws = MockWebSocket.getLastInstance()!;
    ws.simulateOpen();

    ws.simulateMessage(
      outputMessage(
        ndjson({ v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking...' }),
        100,
        1,
      ),
    );
    ws.simulateMessage(
      outputMessage(ndjson({ v: 1, type: 'restore-failure-declaration' }), 200, 1),
    );

    const thinkingEntry = instance
      .getSnapshot()
      .entries.find((e): e is Extract<EmbeddedAgentChatEntry, { kind: 'assistant-thinking' }> => {
        return e.kind === 'assistant-thinking';
      });
    expect(thinkingEntry).toBeDefined();
    expect(thinkingEntry!.streaming).toBe(true);
  });
});
