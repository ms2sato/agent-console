/**
 * The rotation -> restore chain, end to end through both real components
 * (#1445): a real `WorkerOutputFileManager` actually rotates a file, and the
 * real `reconstructConversation` reads the resulting live window.
 *
 * **Why this file exists rather than more unit tests.** The defect was not in
 * either component. `cutSegment` cut at a byte offset, which is correct for a
 * byte-oriented archive; `parseStreamEvents` rejected a malformed line, which
 * is correct for a strict parser. The failure lived in the seam: the cut
 * produced a partial first record and the parser was handed it. Only a test
 * that drives both can observe that.
 *
 * **The load-bearing assertion is the orphan guard firing.** `replayWindow`
 * has a guard for a window that starts mid-turn -- its own comment says "a
 * rotated-out restore window can start mid-turn" -- and it was unreachable:
 * the parse gate one layer above threw first on ~99% of rotations, so control
 * never arrived. A test that only asserted "reconstruction no longer throws"
 * would not distinguish "the gate opened" from "the gate still fails, just
 * differently". So the orphan test asserts on the ERROR MESSAGE, not the error
 * type: both failures are `RestoreReconstructionError`, and only the message
 * says which layer produced it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import { writeManifestDurable, createInitialManifest, manifestPathFor } from '../worker-output-manifest.js';
import * as path from 'path';
import { fs as memfs } from 'memfs';
import { reconstructConversation, RestoreReconstructionError } from '@agent-console/embedded-agent/src/restore.js';
import type { EmbeddedAgentStreamEvent } from '@agent-console/shared';

const CONFIG_DIR = '/test/config';
const resolver = new SessionDataPathResolver(`${CONFIG_DIR}/_frag`);
const S = 'session-frag';
const W = 'w-frag';
const SYSTEM_PROMPT = 'You are a helpful assistant.';

const line = (e: EmbeddedAgentStreamEvent) => `${JSON.stringify(e)}\n`;

/**
 * Rotate `records` in one flush, cutting so the live window opens INSIDE
 * `records[splitAt - 1]` -- and therefore, after the newline alignment, at the
 * start of `records[splitAt]`.
 *
 * The cut point is `size - floor(0.8 * fileMaxSize)`, so choosing
 * `fileMaxSize` places it. Solved here rather than tuned by hand: a test that
 * depended on a cut landing somewhere by luck would stop testing this the
 * first time a record's length changed.
 */
async function rotateSplittingInside(records: string[], splitAt: number): Promise<string> {
  const stream = records.join('');
  const total = Buffer.byteLength(stream, 'utf-8');
  const offsetOf = (i: number) => Buffer.byteLength(records.slice(0, i).join(''), 'utf-8');
  // Land mid-way through the record before the intended split.
  const desiredCut = Math.floor((offsetOf(splitAt - 1) + offsetOf(splitAt)) / 2);
  const fileMaxSize = Math.ceil((total - desiredCut) / 0.8);
  if (fileMaxSize >= total) throw new Error('fixture would not rotate; use more records');

  const m = new WorkerOutputFileManager({ flushThreshold: 100_000_000, flushInterval: 100_000, fileMaxSize });
  m.bufferOutput(S, W, stream, resolver);
  await m.flushAll();

  const res = await m.readHistoryWithOffset(S, W, resolver);
  expect(res.startOffset).toBeGreaterThan(0); // it really rotated
  return res.data;
}

describe('rotation -> restore: a fragment head no longer poisons the gate', () => {
  beforeEach(() => setupMemfs());
  afterEach(() => cleanupMemfs());

  /**
   * Seed a worker that ALREADY rotated under the old, byte-aligned cut: a live
   * file whose first line is the tail of an archived record.
   *
   * This has to be seeded rather than produced, because (a) makes the manager
   * incapable of creating it -- which is the point of (a), and exactly why (b)
   * is a separate fix rather than a belt on the same braces. Every worker that
   * rotated before this PR is in this state on disk right now, and no amount
   * of newline-aligning future cuts reaches them.
   */
  async function seedAlreadyRotated(liveContent: string, archivedBytes: number): Promise<string> {
    const outputsDir = resolver.getOutputsDir();
    const workerDir = path.join(outputsDir, S);
    await memfs.promises.mkdir(workerDir, { recursive: true });
    const manifest = createInitialManifest(1);
    manifest.liveBaseOffset = archivedBytes;
    await writeManifestDurable(manifestPathFor(outputsDir, S, W), manifest);
    await memfs.promises.writeFile(resolver.getOutputFilePath(S, W), liveContent, { encoding: 'utf-8' });

    const m = new WorkerOutputFileManager({ flushThreshold: 100_000_000, flushInterval: 100_000 });
    const res = await m.readHistoryWithOffset(S, W, resolver);
    expect(res.startOffset).toBe(archivedBytes);
    return res.data;
  }

  it('reaches the orphan guard, which the parse gate used to pre-empt', async () => {
    // The window opens on the TAIL of an archived tool-call record, and the
    // next whole record is the tool-result whose owner is gone -- the shape
    // `replayWindow`'s guard was written for and has never been reached with.
    const fragment = 'lId":"c1","name":"run","args":{}}\n';
    const live =
      fragment +
      line({ v: 1, type: 'context-compacted', source: 'manual', summary: 'earlier turns' }) +
      line({ v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' }) +
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'after' });
    const window = await seedAlreadyRotated(live, 4096);

    expect(() => JSON.parse(window.split('\n')[0])).toThrow(); // it really is a fragment

    let message = '';
    try {
      reconstructConversation(window, SYSTEM_PROMPT, true);
      throw new Error('expected a RestoreReconstructionError');
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreReconstructionError);
      message = (err as Error).message;
    }

    // THE assertion, and it is on the MESSAGE rather than the type because
    // both layers throw the same class. Before (b) this read "Unparseable line
    // in persisted stream" -- the parse gate, one layer above, refusing to
    // hand over control. Naming the orphan proves the fragment was skipped and
    // `replayWindow` actually ran.
    //
    // Reach measured by mutation: removing (b)'s head allowance flips this
    // message back to the parse error and fails this test. Measured, not
    // assumed -- an earlier version of this test drove a REAL rotation, which
    // (a) newline-aligns, so there was no fragment for (b) to skip and the
    // whole file passed with (b) deleted.
    expect(message).toContain('tool-result');
    expect(message).toContain('no owning tool-call');
    expect(message).not.toContain('Unparseable line');
  });

  it('restores an already-rotated worker that used to fall to the destructive reset', async () => {
    // The recovery (b) exists for: same seeded shape, but the surviving window
    // is self-consistent, so it reconstructs instead of resetting.
    const live =
      'ext":"the tail of an archived record"}\n' +
      line({ v: 1, type: 'context-compacted', source: 'manual', summary: 'earlier turns' }) +
      line({ v: 1, type: 'user-message', id: 'm9', text: 'still here' }) +
      line({ v: 1, type: 'assistant-message', turnId: 't9', text: 'and so is this' });
    const window = await seedAlreadyRotated(live, 8192);

    const outcome = reconstructConversation(window, SYSTEM_PROMPT, true);
    expect(outcome.conversation.at(-1)).toMatchObject({ role: 'assistant', content: 'and so is this' });
  });

  it('reconstructs an openai-api transcript across a rotation', async () => {
    const records = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'q'.repeat(60) }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'a'.repeat(60) }),
      line({ v: 1, type: 'user-message', id: 'm2', text: 'second question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'second answer' }),
    ];
    const window = await rotateSplittingInside(records, 2);

    const outcome = reconstructConversation(window, SYSTEM_PROMPT, true);
    expect(outcome.conversation.at(-1)).toMatchObject({ role: 'assistant', content: 'second answer' });
  });

  it('reconstructs a claude-sdk transcript across a rotation', async () => {
    // Q9, both engines. The reconstruction itself is engine-agnostic; what is
    // engine-specific in a persisted stream is which event types appear.
    // `sdk-session-id` is `claude-sdk`-only and is replay noise -- so this
    // pins that the head allowance does not interact with the events only one
    // engine ever writes, including when the fragment is one of them.
    //
    // What this does NOT cover, stated so it is not read as more: the
    // service-level `restore-info` for a failed restore is #1449's, and the
    // `sdkResumed` flag is set by the service, not by this function.
    const records = [
      line({ v: 1, type: 'sdk-session-id', sdkSessionId: 'sess-abc' }),
      line({ v: 1, type: 'user-message', id: 'm1', text: 'q'.repeat(60) }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'a'.repeat(60) }),
      line({ v: 1, type: 'user-message', id: 'm2', text: 'later question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'later answer' }),
    ];
    const window = await rotateSplittingInside(records, 3);

    const outcome = reconstructConversation(window, SYSTEM_PROMPT, true);
    expect(outcome.conversation.at(-1)).toMatchObject({ role: 'assistant', content: 'later answer' });
  });

  it('the live window really does open on a whole record now', async () => {
    // The (a) half, observed through the same real chain rather than inferred
    // from the unit pin: after rotation the first line parses on its own.
    const records = Array.from({ length: 8 }, (_, i) =>
      line({ v: 1, type: 'user-message', id: `m${i}`, text: 'p'.repeat(50) }),
    );
    const window = await rotateSplittingInside(records, 4);
    expect(() => JSON.parse(window.split('\n')[0])).not.toThrow();
  });
});
