import { describe, it, expect, mock } from 'bun:test';
import type { InteractiveProcessInfo } from '@agent-console/shared';
import {
  routeProcessContent,
  routeProcessExit,
  deliveryTails,
  splitContentIntoChunks,
  MESSAGE_CHUNK_TARGET_BYTES,
  type ProcessOutputRouterDeps,
} from '../process-output-router.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import type { PtyNotificationParams } from '../../lib/pty-notification.js';

function makeProcess(
  overrides: Partial<InteractiveProcessInfo> = {},
): InteractiveProcessInfo {
  return {
    id: 'proc-1',
    sessionId: 'session-1',
    workerId: 'worker-1',
    command: 'node script.js',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    outputMode: 'pty',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ProcessOutputRouterDeps> = {},
): {
  deps: ProcessOutputRouterDeps;
  deliverNotification: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
  getResolver: ReturnType<typeof mock>;
} {
  const deliverNotification = mock(
    async (_sessionId: string, _workerId: string, _params: PtyNotificationParams) =>
      ({ ok: true }) as { ok: true } | { ok: false; error: string },
  );
  const sendMessage = mock(async (params: { content: string }) => ({
    messageId: `msg-${Math.random().toString(16).slice(2, 10)}.json`,
    path: `/tmp/messages/${params.content.slice(0, 4)}.json`,
  }));
  const resolver = new SessionDataPathResolver('/tmp/test-base');
  const getResolver = mock((_sessionId: string) => resolver as SessionDataPathResolver | null);

  const deps: ProcessOutputRouterDeps = {
    getResolver:
      overrides.getResolver ?? ((sessionId) => getResolver(sessionId)),
    deliverNotification:
      overrides.deliverNotification ??
      ((sessionId, workerId, params) => deliverNotification(sessionId, workerId, params)),
    sendMessage: overrides.sendMessage ?? ((params) => sendMessage(params)),
  };
  return { deps, deliverNotification, sendMessage, getResolver };
}

describe('splitContentIntoChunks', () => {
  it('returns an empty array for empty input', () => {
    expect(splitContentIntoChunks('', 100)).toEqual([]);
  });

  it('returns a single chunk when content fits within targetBytes', () => {
    expect(splitContentIntoChunks('hello world', 1024)).toEqual(['hello world']);
  });

  it('splits content larger than targetBytes into multiple chunks', () => {
    const content = 'a'.repeat(2500);
    const chunks = splitContentIntoChunks(content, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Reassembly is lossless.
    expect(chunks.join('')).toBe(content);
    // Each chunk respects the byte budget.
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf-8')).toBeLessThanOrEqual(1000);
    }
  });

  it('prefers cutting at a newline boundary inside the candidate prefix', () => {
    // 200 bytes total. With targetBytes=120, the first cut should land on the
    // newline at index 100 (cut=101), not on a non-newline byte.
    const line1 = 'a'.repeat(100);
    const line2 = 'b'.repeat(99);
    const content = `${line1}\n${line2}`;
    const chunks = splitContentIntoChunks(content, 120);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The first chunk should end exactly at the newline.
    expect(chunks[0].endsWith('\n')).toBe(true);
    expect(chunks[0]).toBe(`${line1}\n`);
    expect(chunks.join('')).toBe(content);
  });

  it('falls back to a hard cut when no newline exists in the candidate prefix', () => {
    const content = 'x'.repeat(3000);
    const chunks = splitContentIntoChunks(content, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(content);
  });

  it('throws RangeError when targetBytes is zero or negative', () => {
    expect(() => splitContentIntoChunks('hello', 0)).toThrow(RangeError);
    expect(() => splitContentIntoChunks('hello', -1)).toThrow(RangeError);
  });

  it('throws RangeError when targetBytes is not an integer', () => {
    expect(() => splitContentIntoChunks('hello', 1.5)).toThrow(RangeError);
    expect(() => splitContentIntoChunks('hello', NaN)).toThrow(RangeError);
    expect(() => splitContentIntoChunks('hello', Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it('does not split a UTF-16 surrogate pair across chunks (emoji boundary)', () => {
    // Build content where a hard byte cut would land between the high and
    // low surrogate of an emoji. Each emoji 😀 is 4 bytes UTF-8 / 2 chars
    // UTF-16. Target 5 bytes forces a cut after the first emoji's first byte
    // would be illegal — the splitter must move the cut to a code-point
    // boundary instead.
    const content = '😀😀😀'; // 12 bytes UTF-8, 6 chars UTF-16
    const chunks = splitContentIntoChunks(content, 5);
    // Reassembly is lossless and each chunk is decodable as valid UTF-8.
    expect(chunks.join('')).toBe(content);
    for (const chunk of chunks) {
      // A surrogate pair never spans the chunk boundary if every emoji
      // appears whole in the chunk that contains its code point. Verify
      // that decoding chunk to UTF-8 round-trips back to the same string.
      expect(Buffer.from(chunk, 'utf-8').toString('utf-8')).toBe(chunk);
      // No lone high surrogate at the end of any chunk.
      const lastChar = chunk.charCodeAt(chunk.length - 1);
      expect(lastChar >= 0xd800 && lastChar <= 0xdbff).toBe(false);
    }
  });

  it('preserves emoji integrity in mixed text crossing chunk boundaries', () => {
    // Mixed ASCII + emoji content larger than the target byte budget.
    const text = 'aaaaa😀bbbbb😀ccccc😀ddddd😀eeeee';
    const chunks = splitContentIntoChunks(text, 8);
    expect(chunks.join('')).toBe(text);
    // Every emoji should appear exactly 4 times across the chunks
    // (no halves dropped or duplicated).
    expect(text.match(/😀/g)?.length).toBe(4);
    expect(chunks.join('').match(/😀/g)?.length).toBe(4);
  });
});

describe('routeProcessContent (pty mode)', () => {
  it('delivers the full content as an [internal-process] notification with the structured params', async () => {
    const { deps, deliverNotification, sendMessage } = makeDeps();
    const process = makeProcess({ outputMode: 'pty' });

    await routeProcessContent(deps, {
      process,
      content: 'full stdout content',
      direction: 'stdout',
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deliverNotification).toHaveBeenCalledTimes(1);
    const [sessionId, workerId, params] = deliverNotification.mock.calls[0] as [
      string,
      string,
      PtyNotificationParams,
    ];
    expect(sessionId).toBe('session-1');
    expect(workerId).toBe('worker-1');
    expect(params).toEqual({
      kind: 'internal-process',
      tag: 'internal:process',
      fields: {
        processId: 'proc-1',
        command: 'node script.js',
        message: 'full stdout content',
      },
      intent: 'triage',
    });
  });

  it('does nothing for empty content', async () => {
    const { deps, deliverNotification, sendMessage } = makeDeps();
    const process = makeProcess({ outputMode: 'pty' });

    await routeProcessContent(deps, { process, content: '', direction: 'stdout' });

    expect(deliverNotification).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('logs a warning and does not throw when deliverNotification reports a failure', async () => {
    const { deps, sendMessage } = makeDeps({
      deliverNotification: async () => ({ ok: false, error: 'worker gone' }),
    });
    const process = makeProcess({ outputMode: 'pty' });

    await expect(
      routeProcessContent(deps, {
        process,
        content: 'full stdout content',
        direction: 'stdout',
      }),
    ).resolves.toBeUndefined();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('logs a warning and does not throw when deliverNotification rejects', async () => {
    const { deps, sendMessage } = makeDeps({
      deliverNotification: async () => {
        throw new Error('boom');
      },
    });
    const process = makeProcess({ outputMode: 'pty' });

    await expect(
      routeProcessContent(deps, {
        process,
        content: 'full stdout content',
        direction: 'stdout',
      }),
    ).resolves.toBeUndefined();

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('routeProcessContent (message mode)', () => {
  it('calls sendMessage with self-routing target ids and the original content', async () => {
    const { deps, deliverNotification, sendMessage } = makeDeps();
    const process = makeProcess({ outputMode: 'message' });

    await routeProcessContent(deps, {
      process,
      content: 'hello from script',
      direction: 'stdout',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendArgs = sendMessage.mock.calls[0]?.[0] as {
      toSessionId: string;
      toWorkerId: string;
      fromSessionId: string;
      content: string;
    };
    expect(sendArgs.toSessionId).toBe('session-1');
    expect(sendArgs.toWorkerId).toBe('worker-1');
    expect(sendArgs.fromSessionId).toBe('session-1');
    expect(sendArgs.content).toBe('hello from script');

    // Brief notification with file path and bytes, delivered via the same
    // structured-params seam as the pty branch.
    expect(deliverNotification).toHaveBeenCalledTimes(1);
    const [sessionId, workerId, params] = deliverNotification.mock.calls[0] as [
      string,
      string,
      PtyNotificationParams,
    ];
    expect(sessionId).toBe('session-1');
    expect(workerId).toBe('worker-1');
    expect(params.kind).toBe('internal-process');
    expect(params.tag).toBe('internal:process');
    expect(params.intent).toBe('triage');
    const fields = params.fields as { processId: string; command: string; message: string };
    expect(fields.processId).toBe('proc-1');
    expect(fields.command).toBe('node script.js');
    expect(fields.message).toContain('stdout via message');
    expect(fields.message).toContain('bytes=');
  });

  it('uses [response via message] phrasing and inform intent for direction=response', async () => {
    const { deps, deliverNotification } = makeDeps();
    const process = makeProcess({ outputMode: 'message' });

    await routeProcessContent(deps, {
      process,
      content: 'response payload',
      direction: 'response',
    });

    const [, , params] = deliverNotification.mock.calls[0] as [string, string, PtyNotificationParams];
    expect(params.intent).toBe('inform');
    const fields = params.fields as { message: string };
    expect(fields.message).toContain('response via message');
  });

  it('splits content larger than MESSAGE_CHUNK_TARGET_BYTES into multiple sendMessage calls', async () => {
    const { deps, sendMessage, deliverNotification } = makeDeps();
    const process = makeProcess({ outputMode: 'message' });

    // Use a synthetic content >2 chunks. Target is ~60 KB; build ~150 KB.
    const blockBytes = MESSAGE_CHUNK_TARGET_BYTES + 1024;
    const content = 'a'.repeat(blockBytes) + '\n' + 'b'.repeat(blockBytes) + '\n' + 'c'.repeat(blockBytes);

    await routeProcessContent(deps, {
      process,
      content,
      direction: 'stdout',
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Reassembling chunks must equal original content.
    const reassembled = sendMessage.mock.calls
      .map((c) => (c[0] as { content: string }).content)
      .join('');
    expect(reassembled).toBe(content);

    // One brief notification per chunk.
    expect(deliverNotification.mock.calls.length).toBeGreaterThanOrEqual(sendMessage.mock.calls.length);
  });

  it('rejects when getResolver returns null so callers can detect the failure', async () => {
    const { deps, sendMessage, deliverNotification } = makeDeps({
      getResolver: () => null,
    });
    const process = makeProcess({ outputMode: 'message' });

    await expect(
      routeProcessContent(deps, {
        process,
        content: 'unreachable',
        direction: 'stdout',
      }),
    ).rejects.toThrow(/Cannot resolve data path/);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deliverNotification).not.toHaveBeenCalled();
  });

  it('rejects when sendMessage fails so callers can report write failure', async () => {
    const failingSend = mock(async (_params: unknown): Promise<{ messageId: string; path: string }> => {
      throw new Error('disk full');
    });
    const { deps, deliverNotification } = makeDeps({
      sendMessage: (params) => failingSend(params),
    });
    const process = makeProcess({ outputMode: 'message' });

    await expect(
      routeProcessContent(deps, {
        process,
        content: 'a single chunk',
        direction: 'response',
      }),
    ).rejects.toThrow(/disk full/);

    // Notification was not emitted for the failed chunk.
    expect(deliverNotification).not.toHaveBeenCalled();
  });

  it('logs a warning and does not throw when deliverNotification reports a failure after a successful chunk write', async () => {
    const { deps, sendMessage } = makeDeps({
      deliverNotification: async () => ({ ok: false, error: 'worker gone' }),
    });
    const process = makeProcess({ outputMode: 'message' });

    await expect(
      routeProcessContent(deps, {
        process,
        content: 'a single chunk',
        direction: 'stdout',
      }),
    ).resolves.toBeUndefined();

    // The chunk write itself still succeeded -- only the brief notification failed.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and does not throw when deliverNotification rejects after a successful chunk write', async () => {
    const { deps, sendMessage } = makeDeps({
      deliverNotification: async () => {
        throw new Error('boom');
      },
    });
    const process = makeProcess({ outputMode: 'message' });

    await expect(
      routeProcessContent(deps, {
        process,
        content: 'a single chunk',
        direction: 'stdout',
      }),
    ).resolves.toBeUndefined();

    // The chunk write itself still succeeded -- only the notification rejected.
    // This is the regression case for write_process_response: a notification
    // hiccup must not turn its `written: true` result into `written: false`.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // Negative control for the two tests above (per workflow.md's "A check's
  // existence is not its detection power"): a rejecting sendMessage must
  // still propagate as a rejection (unchanged behavior), proving the
  // try/catch added around deliverNotification is scoped to that call only
  // and is not a blanket try/catch around the whole function. Covered
  // already by 'rejects when sendMessage fails so callers can report write
  // failure' above -- confirmed still passing after the fix (see polarity
  // note in the PR description).
});

describe('routeProcessExit ordering (Issue #1591)', () => {
  function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('R1: message mode -- exit notification waits for a still-pending stdout content step', async () => {
    const order: string[] = [];
    const gate = createDeferred<{ messageId: string; path: string }>();
    const sendMessage = mock(async (_params: { content: string }) => {
      return gate.promise;
    });
    const deliverNotification = mock(async (_s: string, _w: string, params: PtyNotificationParams) => {
      const message = (params.fields as { message: string }).message;
      order.push(message.startsWith('Process exited') ? 'exit' : 'stdout-brief');
      return { ok: true } as const;
    });
    const { deps } = makeDeps({
      sendMessage: (p) => sendMessage(p),
      deliverNotification: (s, w, p) => deliverNotification(s, w, p),
    });
    const process = makeProcess({ id: 'order-stdout-exit', outputMode: 'message' });

    const stdoutPromise = routeProcessContent(deps, {
      process,
      content: 'stdout text',
      direction: 'stdout',
    });
    const exitPromise = routeProcessExit(deps, process);

    // Let the microtask queue turn over. If the fix regressed, the exit
    // notification does not depend on `gate` at all and would already have
    // been recorded here.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual([]);

    gate.resolve({ messageId: 'msg-1', path: '/tmp/messages/1.json' });
    await Promise.all([stdoutPromise, exitPromise]);

    expect(order).toEqual(['stdout-brief', 'exit']);
  });

  it('R1: message mode -- response -> stdout -> exit deliver in enqueue order even when later steps individually resolve faster', async () => {
    const order: string[] = [];
    const responseGate = createDeferred<{ messageId: string; path: string }>();
    let sendMessageCalls = 0;
    const sendMessage = mock(async (_params: { content: string }) => {
      sendMessageCalls += 1;
      if (sendMessageCalls === 1) {
        return responseGate.promise; // response step: held open
      }
      return { messageId: `msg-${sendMessageCalls}`, path: `/tmp/messages/${sendMessageCalls}.json` }; // stdout step: fast
    });
    const deliverNotification = mock(async (_s: string, _w: string, params: PtyNotificationParams) => {
      const message = (params.fields as { message: string }).message;
      if (message.startsWith('Process exited')) order.push('exit');
      else if (message.includes('response via message')) order.push('response-brief');
      else order.push('stdout-brief');
      return { ok: true } as const;
    });
    const { deps } = makeDeps({
      sendMessage: (p) => sendMessage(p),
      deliverNotification: (s, w, p) => deliverNotification(s, w, p),
    });
    const process = makeProcess({ id: 'order-response-stdout-exit', outputMode: 'message' });

    const responsePromise = routeProcessContent(deps, { process, content: 'response payload', direction: 'response' });
    const stdoutPromise = routeProcessContent(deps, { process, content: 'stdout text', direction: 'stdout' });
    const exitPromise = routeProcessExit(deps, process);

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual([]);

    responseGate.resolve({ messageId: 'msg-response', path: '/tmp/messages/response.json' });
    await Promise.all([responsePromise, stdoutPromise, exitPromise]);

    expect(order).toEqual(['response-brief', 'stdout-brief', 'exit']);
  });

  it('R1 pty-mode no-regression: exit notification still waits for a still-pending stdout notification', async () => {
    const order: string[] = [];
    const gate = createDeferred<{ ok: true }>();
    let deliverCalls = 0;
    const deliverNotification = mock(async (_s: string, _w: string, params: PtyNotificationParams) => {
      deliverCalls += 1;
      const message = (params.fields as { message: string }).message;
      if (deliverCalls === 1) {
        await gate.promise; // stdout notification: held open
      }
      order.push(message.startsWith('Process exited') ? 'exit' : 'stdout');
      return { ok: true } as const;
    });
    const { deps } = makeDeps({ deliverNotification: (s, w, p) => deliverNotification(s, w, p) });
    const process = makeProcess({ id: 'order-pty-stdout-exit', outputMode: 'pty' });

    const stdoutPromise = routeProcessContent(deps, { process, content: 'stdout text', direction: 'stdout' });
    const exitPromise = routeProcessExit(deps, process);

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual([]);

    gate.resolve({ ok: true });
    await Promise.all([stdoutPromise, exitPromise]);

    expect(order).toEqual(['stdout', 'exit']);
  });

  it('R2: a rejected step does not block the next enqueued step, and its own rejection is still observable on its own promise', async () => {
    const resolver = new SessionDataPathResolver('/tmp/test-base');
    let getResolverCalls = 0;
    const { deps, sendMessage } = makeDeps({
      getResolver: () => {
        getResolverCalls += 1;
        return getResolverCalls === 1 ? null : resolver;
      },
    });
    const process = makeProcess({ id: 'order-reject', outputMode: 'message' });

    const first = routeProcessContent(deps, { process, content: 'first (fails)', direction: 'stdout' });
    const second = routeProcessContent(deps, { process, content: 'second (succeeds)', direction: 'response' });

    await expect(first).rejects.toThrow(/Cannot resolve data path/);
    await expect(second).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls[0]?.[0] as { content: string }).content).toBe('second (succeeds)');
  });

  it('R3: deletes the per-process delivery tail entry once the exit step settles', async () => {
    const process = makeProcess({ id: 'order-cleanup', outputMode: 'pty' });
    const { deps } = makeDeps();

    await routeProcessContent(deps, { process, content: 'stdout text', direction: 'stdout' });
    expect(deliveryTails.has('order-cleanup')).toBe(true);

    await routeProcessExit(deps, process);
    expect(deliveryTails.has('order-cleanup')).toBe(false);
  });

  it('R3: two interleaved processes keep independent delivery order', async () => {
    const events: string[] = [];
    const deliverNotification = mock(async (_s: string, _w: string, params: PtyNotificationParams) => {
      const fields = params.fields as { processId: string; message: string };
      events.push(`${fields.processId}:${fields.message.startsWith('Process exited') ? 'exit' : 'stdout'}`);
      return { ok: true } as const;
    });
    const { deps } = makeDeps({ deliverNotification: (s, w, p) => deliverNotification(s, w, p) });

    const procA = makeProcess({ id: 'proc-interleave-A', outputMode: 'pty' });
    const procB = makeProcess({ id: 'proc-interleave-B', outputMode: 'pty' });

    await Promise.all([
      routeProcessContent(deps, { process: procA, content: 'A stdout', direction: 'stdout' }),
      routeProcessContent(deps, { process: procB, content: 'B stdout', direction: 'stdout' }),
      routeProcessExit(deps, procA),
      routeProcessExit(deps, procB),
    ]);

    const aOrder = events.filter((e) => e.startsWith('proc-interleave-A:')).map((e) => e.split(':')[1]);
    const bOrder = events.filter((e) => e.startsWith('proc-interleave-B:')).map((e) => e.split(':')[1]);
    expect(aOrder).toEqual(['stdout', 'exit']);
    expect(bOrder).toEqual(['stdout', 'exit']);
  });
});
