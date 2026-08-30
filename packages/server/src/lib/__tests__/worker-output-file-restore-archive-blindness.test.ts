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
import { reconstructConversation } from '@agent-console/embedded-agent/src/restore.js';

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

describe('#1202 — the walk-back assembles a stream that starts at a safe anchor', () => {
  let manager: WorkerOutputFileManager;

  beforeEach(() => {
    setupMemfs({});
    process.env.AGENT_CONSOLE_HOME = CONFIG_DIR;
    manager = makeManager(400);
  });

  afterEach(() => {
    cleanupMemfs();
  });

  it('THE FIX: a boundary in the archive is found, and the conversation restores whole', async () => {
    // The same fixture as SHAPE A above. That is deliberate -- the polarity of
    // this pin is that fixture's own silent truncation on unmodified code.
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'first question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'first answer' }),
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

    // Premise control: the live window alone still cannot see the boundary.
    const live = await manager.readHistoryWithOffset(S, W, resolver, undefined);
    expect(live.startOffset).toBeGreaterThan(0);
    expect(live.data).not.toContain('THE SUMMARY');

    const assembled = await manager.readHistoryForRestore(S, W, resolver);

    expect(assembled.stoppedAt).toBe('boundary');
    expect(assembled.data).toContain('THE SUMMARY');

    const outcome = reconstructConversation(assembled.data, SYSTEM_PROMPT, false);
    expect(outcome.conversation.some((m) => String(m.content).includes('THE SUMMARY'))).toBe(true);
    expect(outcome.conversation.some((m) => String(m.content).includes('third question'))).toBe(true);
  });

  it('FAST PATH: a boundary already in the live window reads no archive at all', async () => {
    // Pinned by the returned stop reason AND by the assembled bytes being the
    // live window verbatim -- if an archive read had happened, the data would
    // be longer even though the verdict would look the same.
    const head = line({ v: 1, type: 'user-message', id: 'm0', text: 'ancient history' });
    const rest = [
      line({ v: 1, type: 'context-compacted', source: 'auto', summary: 'RECENT SUMMARY' }),
      line({ v: 1, type: 'user-message', id: 'm2', text: 'after the boundary' }),
    ].join('');

    manager.bufferOutput(S, W, head + 'x'.repeat(400) + '\n', resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, rest, resolver);
    await manager.flushAll();

    const live = await manager.readHistoryWithOffset(S, W, resolver, undefined);
    expect(live.startOffset).toBeGreaterThan(0);
    expect(live.data).toContain('RECENT SUMMARY');

    const assembled = await manager.readHistoryForRestore(S, W, resolver);
    expect(assembled.stoppedAt).toBe('boundary');
    expect(assembled.data).toBe(live.data);
  });

  it('NO BOUNDARY ANYWHERE: walks to the true start and says so', async () => {
    const a = line({ v: 1, type: 'user-message', id: 'm1', text: 'the very first thing' });
    const b = line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'y'.repeat(500) });
    const c = line({ v: 1, type: 'user-message', id: 'm2', text: 'the latest thing' });

    manager.bufferOutput(S, W, a, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, b + c, resolver);
    await manager.flushAll();

    const live = await manager.readHistoryWithOffset(S, W, resolver, undefined);
    expect(live.startOffset).toBeGreaterThan(0);
    expect(live.data).not.toContain('the very first thing');

    const assembled = await manager.readHistoryForRestore(S, W, resolver);
    expect(assembled.stoppedAt).toBe('true-start');
    expect(assembled.data).toContain('the very first thing');
    expect(assembled.data).toContain('the latest thing');
  });

  it('a message whose TEXT quotes the boundary literal does not stop the walk', async () => {
    // Pins that quoting the boundary literal in a message does not derail the
    // walk. It passes for a reason worth stating, because it is NOT the reason
    // the parse in `containsBoundary` exists:
    //
    // `JSON.stringify` escapes the inner quotes, so this message serializes as
    // `\"type\":\"context-compacted\"` and the raw literal never appears.
    // The fast substring negative already returns false. Measured: removing
    // the structural parse leaves this test green.
    //
    // So this is a behaviour pin, not a presence control for the parse. The
    // parse guards input this writer did not produce, and nothing here
    // demonstrates it — recorded rather than implied.
    const quoted = line({
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: 'why does restore look for {"type":"context-compacted"} in the log?',
    });
    // THE PREMISE, ASSERTED RATHER THAN DESCRIBED. An earlier version of this
    // test stated in a comment that the raw literal was present; it is not,
    // because JSON escaping rewrites it. A comment cannot be surprised by
    // that. This can:
    expect(quoted).not.toContain('"type":"context-compacted"');
    expect(quoted).toContain('\\"type\\":\\"context-compacted\\"');
    const filler = line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'z'.repeat(500) });
    const tail = line({ v: 1, type: 'user-message', id: 'm2', text: 'the latest thing' });

    manager.bufferOutput(S, W, quoted, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, filler + tail, resolver);
    await manager.flushAll();

    const assembled = await manager.readHistoryForRestore(S, W, resolver);

    // No real boundary exists anywhere, so the walk must reach the true start.
    expect(assembled.stoppedAt).toBe('true-start');
    expect(assembled.data).toContain('why does restore look for');
  });

  it('CAP: a ceiling below the archive size stops the walk and reports it, rather than assembling everything', async () => {
    const a = line({ v: 1, type: 'user-message', id: 'm1', text: 'the very first thing' });
    const b = line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'y'.repeat(500) });
    manager.bufferOutput(S, W, a, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, b, resolver);
    await manager.flushAll();

    // A cap that the live window alone already fills.
    const assembled = await manager.readHistoryForRestore(S, W, resolver, 10);
    expect(assembled.stoppedAt).toBe('cap');
    expect(assembled.data).not.toContain('the very first thing');
  });
});
