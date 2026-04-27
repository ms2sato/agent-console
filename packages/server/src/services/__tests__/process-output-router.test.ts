import { describe, it, expect, mock } from 'bun:test';
import type { InteractiveProcessInfo } from '@agent-console/shared';
import {
  routeProcessContent,
  splitContentIntoChunks,
  MESSAGE_CHUNK_TARGET_BYTES,
  type ProcessOutputRouterDeps,
} from '../process-output-router.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';

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
  writeInput: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
  getResolver: ReturnType<typeof mock>;
} {
  const writeInput = mock((_sessionId: string, _workerId: string, _data: string) => {});
  const sendMessage = mock(async (params: { content: string }) => ({
    messageId: `msg-${Math.random().toString(16).slice(2, 10)}.json`,
    path: `/tmp/messages/${params.content.slice(0, 4)}.json`,
  }));
  const resolver = new SessionDataPathResolver('/tmp/test-base');
  const getResolver = mock((_sessionId: string) => resolver as SessionDataPathResolver | null);

  const deps: ProcessOutputRouterDeps = {
    getResolver:
      overrides.getResolver ?? ((sessionId) => getResolver(sessionId)),
    writeInput:
      overrides.writeInput ??
      ((sessionId, workerId, data) => {
        writeInput(sessionId, workerId, data);
      }),
    sendMessage: overrides.sendMessage ?? ((params) => sendMessage(params)),
  };
  return { deps, writeInput, sendMessage, getResolver };
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
  it('writes the full content as an [internal:process] PTY notification', async () => {
    const { deps, writeInput, sendMessage } = makeDeps();
    const process = makeProcess({ outputMode: 'pty' });

    await routeProcessContent(deps, {
      process,
      content: 'full stdout content',
      direction: 'stdout',
    });

    expect(sendMessage).not.toHaveBeenCalled();
    // writeInput is called twice: once with the notification text, once with \r
    // (delayed via setTimeout 150ms — only the first call is observed
    // synchronously after await).
    expect(writeInput).toHaveBeenCalled();
    const firstCall = writeInput.mock.calls[0] as [string, string, string];
    expect(firstCall[0]).toBe('session-1');
    expect(firstCall[1]).toBe('worker-1');
    expect(firstCall[2]).toContain('[internal:process]');
    expect(firstCall[2]).toContain('processId=proc-1');
    expect(firstCall[2]).toContain('full stdout content');
  });

  it('does nothing for empty content', async () => {
    const { deps, writeInput, sendMessage } = makeDeps();
    const process = makeProcess({ outputMode: 'pty' });

    await routeProcessContent(deps, { process, content: '', direction: 'stdout' });

    expect(writeInput).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('routeProcessContent (message mode)', () => {
  it('calls sendMessage with self-routing target ids and the original content', async () => {
    const { deps, writeInput, sendMessage } = makeDeps();
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

    // Brief PTY notification with file path and bytes.
    expect(writeInput).toHaveBeenCalled();
    const firstCall = writeInput.mock.calls[0] as [string, string, string];
    expect(firstCall[2]).toContain('[internal:process]');
    expect(firstCall[2]).toContain('stdout via message');
    expect(firstCall[2]).toContain('bytes=');
  });

  it('uses [response via message] phrasing for direction=response', async () => {
    const { deps, writeInput } = makeDeps();
    const process = makeProcess({ outputMode: 'message' });

    await routeProcessContent(deps, {
      process,
      content: 'response payload',
      direction: 'response',
    });

    const firstCall = writeInput.mock.calls[0] as [string, string, string];
    expect(firstCall[2]).toContain('response via message');
  });

  it('splits content larger than MESSAGE_CHUNK_TARGET_BYTES into multiple sendMessage calls', async () => {
    const { deps, sendMessage, writeInput } = makeDeps();
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

    // One brief PTY notification per chunk.
    expect(writeInput.mock.calls.length).toBeGreaterThanOrEqual(sendMessage.mock.calls.length);
  });

  it('rejects when getResolver returns null so callers can detect the failure', async () => {
    const { deps, sendMessage, writeInput } = makeDeps({
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
    expect(writeInput).not.toHaveBeenCalled();
  });

  it('rejects when sendMessage fails so callers can report write failure', async () => {
    const failingSend = mock(async (_params: unknown): Promise<{ messageId: string; path: string }> => {
      throw new Error('disk full');
    });
    const { deps, writeInput } = makeDeps({
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

    // PTY notification was not emitted for the failed chunk.
    expect(writeInput).not.toHaveBeenCalled();
  });
});
