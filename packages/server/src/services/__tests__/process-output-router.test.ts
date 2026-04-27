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
  const writeInput = mock(() => {});
  const sendMessage = mock(async (params: { content: string }) => ({
    messageId: `msg-${Math.random().toString(16).slice(2, 10)}.json`,
    path: `/tmp/messages/${params.content.slice(0, 4)}.json`,
  }));
  const resolver = new SessionDataPathResolver('/tmp/test-base');
  const getResolver = mock(() => resolver);

  const deps: ProcessOutputRouterDeps = {
    getResolver: overrides.getResolver ?? (getResolver as unknown as ProcessOutputRouterDeps['getResolver']),
    writeInput: overrides.writeInput ?? (writeInput as unknown as ProcessOutputRouterDeps['writeInput']),
    sendMessage: overrides.sendMessage ?? (sendMessage as unknown as ProcessOutputRouterDeps['sendMessage']),
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

  it('skips routing when getResolver returns null and emits no PTY notification', async () => {
    const { deps, sendMessage, writeInput, getResolver } = makeDeps({
      getResolver: () => null,
    });
    void getResolver;
    const process = makeProcess({ outputMode: 'message' });

    await routeProcessContent(deps, {
      process,
      content: 'unreachable',
      direction: 'stdout',
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(writeInput).not.toHaveBeenCalled();
  });

  it('continues with subsequent chunks when sendMessage fails for one chunk', async () => {
    let callCount = 0;
    const failingSend = mock(async (_params: { content: string }) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('disk full');
      }
      return {
        messageId: 'msg.json',
        path: `/tmp/messages/ok-${callCount}.json`,
      };
    });
    const { deps, writeInput } = makeDeps({
      sendMessage: failingSend as unknown as ProcessOutputRouterDeps['sendMessage'],
    });
    const process = makeProcess({ outputMode: 'message' });

    const blockBytes = MESSAGE_CHUNK_TARGET_BYTES + 256;
    const content = 'x'.repeat(blockBytes) + '\n' + 'y'.repeat(blockBytes);

    await routeProcessContent(deps, { process, content, direction: 'stdout' });

    // Multiple chunks were attempted (>= 2) — failure on the first did not
    // abort the loop.
    expect(failingSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    // PTY notification suppressed for the failed chunk; emitted for each
    // successful chunk (>= 1).
    expect(writeInput.mock.calls.length).toBeGreaterThanOrEqual(1);
    // The number of PTY notifications equals successful sendMessage calls
    // (total - failed = total - 1).
    expect(writeInput.mock.calls.length).toBe(failingSend.mock.calls.length - 1);
  });
});
