/**
 * #1506 — the CLIENT-DISPLAY read (`readHistoryForDisplay`) has the same
 * archive-blindness shape #1202 fixed for the RESTORE read
 * (`readHistoryForRestore`): the live window alone can be far shorter than
 * the line budget once a worker has rotated, and until this method existed
 * the only readers serving a client's initial `request-history` (`readLastNLines`
 * / `readHistoryWithOffset`'s archived-out branch) never looked past it. A
 * client reconnecting after a server restart on a heavily-rotated worker saw
 * "No messages yet" even though the conversation was fully intact on disk
 * (see the Issue's real-walkthrough reproduction, `openai-api`, 29 segments).
 *
 * This mirrors `worker-output-file-restore-archive-blindness.test.ts`'s shape
 * one-for-one, applied to the display consumer instead of the restore one.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { fs as memfs } from 'memfs';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';

const CONFIG_DIR = '/test/config';
const resolver = new SessionDataPathResolver(`${CONFIG_DIR}/_quick`);
const S = 'session-1';
const W = 'w-1';

function makeManager(fileMaxSize: number): WorkerOutputFileManager {
  return new WorkerOutputFileManager({
    flushThreshold: 100_000_000,
    flushInterval: 100_000,
    fileMaxSize,
    maxSegments: 0,
  });
}

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;

describe('#1506 — readHistoryForDisplay walks the archive to fill the line budget', () => {
  let manager: WorkerOutputFileManager;

  beforeEach(() => {
    setupMemfs({});
    process.env.AGENT_CONSOLE_HOME = CONFIG_DIR;
    manager = makeManager(400);
  });

  afterEach(() => {
    cleanupMemfs();
  });

  it('PREMISE: the OLD initial-load path (readLastNLines) still cannot see rotated-out content', async () => {
    // Same fixture as "THE FIX" below. This documents that readLastNLines
    // itself is UNCHANGED by this PR (R2 deliberately leaves the live-only
    // reader alone; only the new method walks the archive) — and reproduces
    // the Issue's own observation (`readLastNLines` is what
    // `getWorkerOutputHistory`'s pre-#1506 initial-load branch called).
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'PRE-ROTATION-MARKER' }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'ack' }),
    ].join('');
    const later = [
      line({ v: 1, type: 'user-message', id: 'm2', text: 'second question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'x'.repeat(600) }),
      line({ v: 1, type: 'user-message', id: 'm3', text: 'third question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't3', text: 'y'.repeat(600) }),
    ].join('');

    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    const live = await manager.readLastNLines(S, W, 8, resolver);
    // PREMISE CONTROL: rotation genuinely happened.
    expect(live.startOffset).toBeGreaterThan(0);
    // The silent form: no error, the content is simply absent.
    expect(live.data).not.toContain('PRE-ROTATION-MARKER');
  });

  it('THE FIX: the initial display window includes pre-rotation content up to the line budget', async () => {
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'PRE-ROTATION-MARKER' }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'ack' }),
    ].join('');
    const later = [
      line({ v: 1, type: 'user-message', id: 'm2', text: 'second question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'x'.repeat(600) }),
      line({ v: 1, type: 'user-message', id: 'm3', text: 'third question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't3', text: 'y'.repeat(600) }),
    ].join('');

    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    // Premise control (same as above): the live window alone cannot see it.
    const live = await manager.readLastNLines(S, W, 8, resolver);
    expect(live.startOffset).toBeGreaterThan(0);
    expect(live.data).not.toContain('PRE-ROTATION-MARKER');

    const display = await manager.readHistoryForDisplay(S, W, resolver, 8);

    expect(display.data).toContain('PRE-ROTATION-MARKER');
    expect(display.data).toContain('third question');
    // startOffset now legitimately precedes the live window's own base — an
    // offset inside an archived segment (R3's consumer-facing fact, #1506).
    expect(display.startOffset).toBeLessThan(live.startOffset);
  });

  it('FAST PATH: a live window that already fills the budget reads NO archive segment', async () => {
    // A budget the live window alone already satisfies, even though archived
    // segments exist from a PRIOR rotation. Measured via a spy on the shared
    // walk primitive (the #1493 "w1" discipline: the returned bytes alone
    // cannot distinguish "read no archive" from "read the archive and it
    // happened to agree with the live window").
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'ancient history' }),
    ].join('');
    manager.bufferOutput(S, W, early + 'x'.repeat(400) + '\n', resolver);
    await manager.flushAll();

    const later = [
      line({ v: 1, type: 'user-message', id: 'm2', text: 'recent one' }),
      line({ v: 1, type: 'user-message', id: 'm3', text: 'recent two' }),
    ].join('');
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    // Premise control: a segment genuinely exists to (not) read.
    const live = await manager.readLastNLines(S, W, 100, resolver);
    expect(live.startOffset).toBeGreaterThan(0);

    type WithArchiveWalk = WorkerOutputFileManager & {
      walkArchiveSegmentsBackward: (...args: never[]) => Promise<unknown>;
    };
    const spy = spyOn(manager as WithArchiveWalk, 'walkArchiveSegmentsBackward');

    // A budget small enough that the live window (2 lines + trailing) already
    // satisfies it.
    const display = await manager.readHistoryForDisplay(S, W, resolver, 2);
    spy.mockRestore();

    expect(spy.mock.calls.length).toBe(0);
    expect(display.data).toContain('recent two');
    expect(display.data).not.toContain('ancient history');
  });

  it('CORRUPT archived segment: degrades to the live window instead of blanking the transcript (CodeRabbit, PR #1510)', async () => {
    // The `readHistoryForRestore` sibling test right next door
    // ("a CORRUPT archived segment is damage, not a pruned edge") asserts the
    // OPPOSITE polarity, on purpose: restore's consumer (runActivation) has a
    // verdict to act on a propagated error -- the destructive reset + sidecar
    // preservation -- so restore must NOT swallow it. Display has no such
    // consumer; the only sound response to a damaged segment mid-walk is the
    // live window this method already had in hand before the walk started,
    // which is exactly the pre-#1506 shape (readLastNLines never touched the
    // archive at all).
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'the very first thing' }),
    ].join('');
    const later = [
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'y'.repeat(500) }),
      line({ v: 1, type: 'user-message', id: 'm2', text: 'the latest thing' }),
    ].join('');
    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    // Premise control: rotation genuinely happened, a segment exists to
    // corrupt, and the live window alone does not already satisfy the
    // (generous) budget below -- so the walk genuinely has to reach it.
    const live = await manager.readLastNLines(S, W, 20, resolver);
    expect(live.startOffset).toBeGreaterThan(0);
    expect(live.data).not.toContain('the very first thing');

    const segDir = `${CONFIG_DIR}/_quick/outputs/${S}`;
    const segFile = (memfs.readdirSync(segDir) as unknown[]).map(String).find((f) => f.includes('.seg-'));
    expect(segFile).toBeTruthy();
    memfs.writeFileSync(`${segDir}/${String(segFile)}`, 'this is not gzip data');

    // THE FIX: no rejection -- the display read degrades to the live window.
    const display = await manager.readHistoryForDisplay(S, W, resolver, 20);
    expect(display.data).toBe(live.data);
    expect(display.startOffset).toBe(live.startOffset);
    expect(display.epoch).toBe(live.epoch);
  });

  it('CAP: a ceiling below the archive size stops the walk early rather than assembling everything', async () => {
    const early = [line({ v: 1, type: 'user-message', id: 'm1', text: 'the very first thing' })].join('');
    const later = [line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'y'.repeat(500) })].join('');
    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    const live = await manager.readLastNLines(S, W, 20, resolver);
    expect(live.startOffset).toBeGreaterThan(0);
    expect(live.data).not.toContain('the very first thing');

    // A generous line budget (would otherwise walk to true start) paired
    // with a byte cap the live window alone already exceeds -- so the walk
    // finds nothing worth adding.
    const display = await manager.readHistoryForDisplay(S, W, resolver, 20, undefined, 5);
    expect(display.data).not.toContain('the very first thing');
  });

  it('ARCHIVED-OUT RECONNECT: a stale nonzero fromOffset (< liveBaseOffset) also walks the archive', async () => {
    // Mirrors "THE FIX" above but through the `fromOffset < base` branch
    // instead of `fromOffset === undefined` -- a client reconnecting with a
    // remembered offset that has since rotated out of the live window (e.g.
    // a brief WS disconnect spanning a rotation) gets the same archive-aware
    // fill, not just a fresh page load.
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'PRE-ROTATION-MARKER' }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'ack' }),
    ].join('');
    const later = [
      line({ v: 1, type: 'user-message', id: 'm2', text: 'second question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'x'.repeat(600) }),
      line({ v: 1, type: 'user-message', id: 'm3', text: 'third question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't3', text: 'y'.repeat(600) }),
    ].join('');

    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    // The client's remembered offset is somewhere in the now-archived early
    // burst -- strictly less than the live window's base.
    const staleFromOffset = 1;
    const display = await manager.readHistoryForDisplay(S, W, resolver, 8, staleFromOffset);

    expect(display.data).toContain('PRE-ROTATION-MARKER');
  });

  it('TRUE INCREMENTAL: a fromOffset inside the live window stays byte-for-byte identical to readHistoryWithOffset (no archive fill)', async () => {
    const early = [line({ v: 1, type: 'user-message', id: 'm1', text: 'first' })].join('');
    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    const later = [line({ v: 1, type: 'user-message', id: 'm2', text: 'second' })].join('');
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    // No rotation in this fixture -- base is 0, so any fromOffset within
    // [0, total) is a true-incremental continuation for BOTH readers.
    const offset = await manager.getCurrentOffset(S, W, resolver);
    const fromOffset = Math.floor(offset / 2);

    const viaOffset = await manager.readHistoryWithOffset(S, W, resolver, fromOffset);
    const viaDisplay = await manager.readHistoryForDisplay(S, W, resolver, 8, fromOffset);

    expect(viaDisplay).toEqual(viaOffset);
  });

  it('CAUGHT UP: fromOffset === total returns an empty continuation, identically to readHistoryWithOffset', async () => {
    const content = [line({ v: 1, type: 'user-message', id: 'm1', text: 'only message' })].join('');
    manager.bufferOutput(S, W, content, resolver);
    await manager.flushAll();

    const total = await manager.getCurrentOffset(S, W, resolver);

    const viaOffset = await manager.readHistoryWithOffset(S, W, resolver, total);
    const viaDisplay = await manager.readHistoryForDisplay(S, W, resolver, 8, total);

    expect(viaDisplay).toEqual(viaOffset);
    expect(viaDisplay.data).toBe('');
  });
});

/**
 * Measured reach, recorded by WHICH test failed (following #1202's
 * "reach recorded by which test failed" convention).
 *
 * Polarity of "THE FIX": commenting out the `walkArchiveSegmentsBackward`
 * call inside `buildDisplayWindow` (forcing it to always fall through to
 * `buildRecentWindow`, i.e. the live-only shape `readLastNLines` already
 * has) makes this test fail on `expect(display.data).toContain('PRE-ROTATION-MARKER')`
 * -- the exact silent-absence shape the PREMISE test pins for the OLD path.
 * Restoring the call makes it pass again. Measured 2026-08-30.
 *
 * Polarity of "CORRUPT archived segment" (CodeRabbit finding, PR #1510):
 * removing the `try { ... } catch (error) { ...; return
 * this.buildRecentWindow(...); }` wrapper around the `walkArchiveSegmentsBackward`
 * call in `buildDisplayWindow` (letting the rejection propagate, matching the
 * pre-fix shape) makes this test fail with the corrupted segment's raw gunzip
 * error (`Z_DATA_ERROR: incorrect header check`) instead of resolving to the
 * live window -- exactly the "one damaged segment blanks the whole
 * transcript" regression the fix removes. All 7 other tests in this file are
 * unaffected by that same mutation (the try/catch is local to the one method
 * they don't exercise a corrupt segment through). Restoring the wrapper
 * passes again. Measured 2026-08-30.
 */
