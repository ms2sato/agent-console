/**
 * Boundary test: restore across a real rotation, through the real storage and
 * the real reconstruction (#1202, AC C7).
 *
 * **Why this exists rather than a native E2E, recorded as a joint decision.**
 * The billable native E2E was skipped, agreed by the delegate and the
 * Orchestrator (the Architect is the third reviewer of that call). The reason
 * is specific rather than convenience: the native harness drives the
 * `claude-sdk` engine, and on that engine `restoredConversation` is **ignored**
 * — `main.ts` gates the branch that consumes it — so a memory-side recall
 * assertion there would have nothing to bite on. Paying for a check whose
 * input cannot reach the condition it names is worse than not writing it.
 *
 * **And "the existing restore E2Es are green" is not evidence.** Grepping
 * `packages/integration/` for `fileMaxSize`, `WORKER_OUTPUT_FILE_MAX_SIZE`,
 * `seg-` and `liveBaseOffset` returns nothing: **no integration test rotates
 * the output file at all.** Every restore E2E runs against a worker whose
 * whole history fits the live window — the exact population this change does
 * not touch. They pass before and after because they never reach the code.
 *
 * So this test does the thing none of them does: it drives a **real**
 * `WorkerOutputFileManager` through a **real** rotation, with a small
 * `fileMaxSize`, and asserts the assembled stream reconstructs whole.
 *
 * **C7 clause 1 — the conversation includes a tool-using turn.** The fixture
 * carries a `tool-call`/`tool-result` pair on purpose: #1462 was precisely a
 * defect where a turn beginning with a tool call failed to restore, and a
 * restore fixture without that shape re-opens a hole that has already been
 * fallen into once.
 *
 * **C7 clause 2 — NOT APPLICABLE, stated so nobody goes looking.** The rule
 * requires a negative control for a recall assertion whose oracle is a model's
 * generated text. Nothing here asks a model anything: the oracle is the
 * reconstructed array, and its content is fully determined by the bytes on
 * disk. There is no non-determinism for a control to bound.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionDataPathResolver } from '@agent-console/server/src/lib/session-data-path-resolver';
import { reconstructConversation } from '@agent-console/embedded-agent/src/restore';

const TEST_CONFIG_DIR = '/test/config';
const resolver = new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`);
const S = 'session-rotation';
const W = 'worker-rotation';
const SYSTEM_PROMPT = 'You are a helpful assistant.';

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;

describe('#1202 boundary — restore across a real rotation, with a tool-using turn', () => {
  let manager: WorkerOutputFileManager;

  beforeEach(() => {
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    manager = new WorkerOutputFileManager({
      flushThreshold: 100_000_000,
      flushInterval: 100_000,
      fileMaxSize: 600,
      maxSegments: 0,
    });
  });

  afterEach(() => {
    cleanupMemfs();
  });

  it('reconstructs the whole conversation, tool pair included, when the boundary rotated into the archive', async () => {
    // Everything before the boundary rotates away. The tool pair sits AFTER
    // it, so the restored window has to carry a `tool-call` and its result
    // through reconstruction -- the shape #1462 showed can fail on its own.
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'the oldest question' }),
      line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'the oldest answer' }),
      line({ v: 1, type: 'context-compacted', source: 'auto', summary: 'DISTILLED HISTORY' }),
    ].join('');

    const withTool = [
      line({ v: 1, type: 'user-message', id: 'm2', text: 'read the notes file' }),
      line({ v: 1, type: 'tool-call', turnId: 't2', callId: 'call-1', name: 'Read', args: { path: 'notes.txt' } }),
      line({ v: 1, type: 'tool-result', turnId: 't2', callId: 'call-1', ok: true, result: 'x'.repeat(400) }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'the notes say hello' }),
      line({ v: 1, type: 'user-message', id: 'm3', text: 'and the newest question' }),
    ].join('');

    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, withTool, resolver);
    await manager.flushAll();

    // PREMISE CONTROLS. Without these the test could pass while exercising
    // nothing: it must genuinely have rotated, and the boundary must genuinely
    // be out of the live window.
    const live = await manager.readHistoryWithOffset(S, W, resolver, undefined);
    expect(live.startOffset).toBeGreaterThan(0);
    expect(live.data).not.toContain('DISTILLED HISTORY');

    const assembled = await manager.readHistoryForRestore(S, W, resolver);
    expect(assembled.stoppedAt).toBe('boundary');

    const outcome = reconstructConversation(assembled.data, SYSTEM_PROMPT, assembled.stoppedAt);

    // The boundary's summary is back, so the restore starts at a declared
    // discard rather than mid-conversation.
    expect(outcome.conversation.some((m) => String(m.content).includes('DISTILLED HISTORY'))).toBe(true);
    // The tool-using turn survived as a provider-valid pair: an assistant
    // message carrying the call, and a `tool` message answering it.
    const toolMessages = outcome.conversation.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBe(1);
    expect((toolMessages[0] as { tool_call_id: string }).tool_call_id).toBe('call-1');
    const assistantWithCall = outcome.conversation.find(
      (m) => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
    );
    expect(assistantWithCall).toBeDefined();
    // And the newest turn is still there, so nothing was lost from the tail
    // while recovering the head.
    expect(outcome.conversation.some((m) => String(m.content).includes('and the newest question'))).toBe(true);
  });

  it('POLARITY: the live window alone yields a conversation missing its head, and does not fail', async () => {
    // The defect, through the same real storage. This is what shipped: no
    // error, no marker, just a shorter conversation. Asserting it here keeps
    // the case above from being a test that would pass either way.
    const early = [
      line({ v: 1, type: 'user-message', id: 'm1', text: 'the oldest question' }),
      line({ v: 1, type: 'context-compacted', source: 'auto', summary: 'DISTILLED HISTORY' }),
    ].join('');
    const later = [
      line({ v: 1, type: 'user-message', id: 'm2', text: 'read the notes file' }),
      line({ v: 1, type: 'tool-call', turnId: 't2', callId: 'call-1', name: 'Read', args: { path: 'notes.txt' } }),
      line({ v: 1, type: 'tool-result', turnId: 't2', callId: 'call-1', ok: true, result: 'x'.repeat(400) }),
      line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'the notes say hello' }),
    ].join('');

    manager.bufferOutput(S, W, early, resolver);
    await manager.flushAll();
    manager.bufferOutput(S, W, later, resolver);
    await manager.flushAll();

    const live = await manager.readHistoryWithOffset(S, W, resolver, undefined);
    expect(live.startOffset).toBeGreaterThan(0);

    // Reconstructing from the live window alone SUCCEEDS -- and silently
    // omits the boundary.
    const fromLiveOnly = reconstructConversation(live.data, SYSTEM_PROMPT, 'true-start');
    expect(fromLiveOnly.conversation.some((m) => String(m.content).includes('DISTILLED HISTORY'))).toBe(false);

    // The walk-back, on the same bytes, recovers it.
    const assembled = await manager.readHistoryForRestore(S, W, resolver);
    const fromWalkBack = reconstructConversation(assembled.data, SYSTEM_PROMPT, assembled.stoppedAt);
    expect(fromWalkBack.conversation.some((m) => String(m.content).includes('DISTILLED HISTORY'))).toBe(true);
  });
});
