/**
 * Q12 reproduction for Issue #1202 — restore is blind to archived segments.
 *
 * This runs against UNMODIFIED behaviour and asserts the defect. It exists so
 * the fix has something that was observed failing first, rather than a claim
 * that it used to.
 *
 * The shape: a worker whose `context-compacted` boundary rotated into an
 * archived segment. Restore reads only the live window, so the boundary is
 * invisible; with the window's leading fragment skipped and no boundary found,
 * reconstruction throws and the worker falls to the destructive reset — losing
 * a conversation that is entirely intact on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import { reconstructConversation, RestoreReconstructionError } from '@agent-console/embedded-agent/src/restore.js';

const CONFIG_DIR = '/test/config';
const resolver = new SessionDataPathResolver(`${CONFIG_DIR}/_quick`);
const S = 'session-1';
const W = 'w-1';
const SYSTEM_PROMPT = 'You are a helpful assistant.';

function makeManager(fileMaxSize: number): WorkerOutputFileManager {
  return new WorkerOutputFileManager({
    flushThreshold: 100_000_000,
    flushInterval: 100_000,
    fileMaxSize,
    maxSegments: 0,
  });
}

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;

describe('#1202 Q12 — restore against a boundary that rotated into the archive', () => {
  let manager: WorkerOutputFileManager;

  beforeEach(() => {
    setupMemfs({});
    process.env.AGENT_CONSOLE_HOME = CONFIG_DIR;
    manager = makeManager(400);
  });

  afterEach(() => {
    cleanupMemfs();
  });

  it('SHAPE A — silent truncation: the cut lands on a line boundary, so restore rebuilds a SHORTER conversation with no error at all', async () => {
    // A conversation with a compaction boundary early, then enough traffic
    // after it to push the boundary out of the live window.
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'first question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'first answer' }),
      // THE BOUNDARY. Everything restore needs to start cleanly is right here.
      line({ v: 1, type: 'context-compacted', source: 'auto', summary: 'THE SUMMARY' }),
    ].join('');

    const later = [
      line({ v: 1, type: 'user-message', id: 'm2', text: 'second question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'second answer' }),
      line({ v: 1, type: 'user-message', id: 'm3', text: 'third question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't3', text: 'third answer' }),
    ].join('');

    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    const read = await manager.readHistoryWithOffset(S, W, resolver, undefined);

    // PREMISE CONTROL for this fixture: without rotation the test would prove
    // nothing, so assert the rotation actually happened before asserting what
    // it caused.
    expect(read.startOffset).toBeGreaterThan(0);

    // The boundary is NOT in what restore can see...
    expect(read.data).not.toContain('THE SUMMARY');

    // ...and reconstruction SUCCEEDS anyway. There is no fragment to skip, so
    // the entry condition never fires: the worker silently comes back with a
    // conversation missing everything before the cut, and nothing anywhere
    // says so. This is the quieter of the two shapes and the worse one.
    const truncated = read.startOffset > 0;
    const outcome = reconstructConversation(read.data, SYSTEM_PROMPT, truncated);
    expect(outcome.conversation.some((m) => String(m.content).includes('THE SUMMARY'))).toBe(false);
    expect(outcome.conversation.some((m) => String(m.content).includes('first question'))).toBe(false);
    // What it DID keep is the tail — a conversation that begins in the middle.
    expect(outcome.conversation.some((m) => String(m.content).includes('third question'))).toBe(true);
  });

  it('SHAPE B is not what rotation produces any more: the cut lands on a record boundary, so no fragment is skipped', async () => {
    // The entry condition is `a fragment was skipped AND no boundary is in the
    // window`. Its first half is what rotation stopped supplying: since
    // `515ec8a0` (#1456, merged 2026-08-30) the cut advances to the start of
    // the next line, and that commit's own comment puts the pre-fix
    // probability of a mid-line cut at about 0.99.
    //
    // So the reset an operator would have seen before that change is not what
    // a rotated worker gets today -- it gets SHAPE A above, silently.
    //
    // NOT a claim that the entry condition is unreachable. One documented
    // path survives, at `worker-output-file.ts`'s fallback where no usable
    // newline exists at or after the character boundary; the cut then lands
    // mid-line and the fragment is real. THAT PATH IS NOT EXERCISED HERE.
    // What this pins is only what rotation does in the ordinary case.
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'first question' }),
      line({ v: 1, type: 'context-compacted', source: 'auto', summary: 'THE SUMMARY' }),
    ].join('');
    const long = line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'X'.repeat(600) });
    const tail = line({ v: 1, type: 'user-message', id: 'm3', text: 'third question' });

    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, long + tail, resolver);
    await manager.flushAll();

    const read = await manager.readHistoryWithOffset(S, W, resolver, undefined);

    expect(read.startOffset).toBeGreaterThan(0);
    expect(read.data).not.toContain('THE SUMMARY');
    // The window opens on a whole record, so there is no fragment to skip.
    expect(read.data.startsWith('{')).toBe(true);
  });

  it('CONTROL: the same conversation restores cleanly when nothing rotated', async () => {
    // The positive control that makes the case above attributable to rotation
    // rather than to the transcript's content. Identical events, a live window
    // large enough to hold them all.
    const spacious = makeManager(1_000_000);
    {
      const all = [
        line({ v: 1, type: 'user-message', id: 'm1', text: 'first question' }),
        line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'first answer' }),
        line({ v: 1, type: 'context-compacted', source: 'auto', summary: 'THE SUMMARY' }),
        line({ v: 1, type: 'user-message', id: 'm2', text: 'second question' }),
        line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'second answer' }),
      ].join('');

      spacious.bufferOutput(S, W, all, resolver);
      await spacious.flushAll();

      const read = await spacious.readHistoryWithOffset(S, W, resolver, undefined);
      expect(read.startOffset).toBe(0);
      expect(read.data).toContain('THE SUMMARY');

      const outcome = reconstructConversation(read.data, SYSTEM_PROMPT, read.startOffset > 0);
      expect(outcome.conversation.some((m) => String(m.content).includes('THE SUMMARY'))).toBe(true);
    }
  });
});
