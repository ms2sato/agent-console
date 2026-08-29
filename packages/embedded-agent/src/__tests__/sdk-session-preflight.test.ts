/**
 * Tests for the R1 resume pre-flight. The module's whole job is to turn
 * `getSessionInfo`'s three possible outcomes -- a record, `undefined`, or a
 * throw -- into the single boolean the caller acts on, so these tests are
 * about that mapping and nothing else.
 *
 * The BEHAVIOUR of `getSessionInfo` itself is a premise, not a claim this
 * file can verify: PS7 (docs/design/embedded-agent-sdk-engine.md §5) is what
 * says a live session is not reported `undefined`, and it was measured
 * against the real SDK rather than against a stub. Stubbing it here would
 * only restate the mapping, which is exactly what these tests are for.
 *
 * The stub is INJECTED, not `mock.module`'d: module-level mocking poisons the
 * whole test process (.claude/rules/testing.md Anti-Pattern #2).
 */
import { describe, it, expect } from 'bun:test';
import type { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { sdkSessionExists } from '../sdk-session-preflight.js';

/**
 * The single documented cast for this file. `SDKSessionInfo` carries several
 * fields this module never reads -- it only checks the value against
 * `undefined` -- so the stubs populate nothing beyond what makes them
 * readable.
 */
function asGetSessionInfo(
  impl: (id: string, opts?: { dir?: string }) => Promise<unknown>,
): typeof getSessionInfo {
  return impl as unknown as typeof getSessionInfo;
}

describe('sdkSessionExists', () => {
  it('is true when the SDK returns a session record', async () => {
    const stub = asGetSessionInfo(async () => ({ sessionId: 'sess-1', summary: 'a chat' }));
    expect(await sdkSessionExists('sess-1', '/tmp/work', stub)).toBe(true);
  });

  it('is false when the SDK returns undefined', async () => {
    const stub = asGetSessionInfo(async () => undefined);
    expect(await sdkSessionExists('sess-gone', '/tmp/work', stub)).toBe(false);
  });

  it('passes the cwd as the `dir` hint', async () => {
    // Not cosmetic: without it the SDK searches every project directory on
    // the host instead of this worker's own (measured at 6 ms vs 63 ms on
    // the miss path, which is the path every fresh worker takes).
    const calls: unknown[][] = [];
    const stub = asGetSessionInfo(async (id, opts) => {
      calls.push([id, opts]);
      return { sessionId: id };
    });
    await sdkSessionExists('sess-1', '/tmp/work', stub);
    expect(calls).toEqual([['sess-1', { dir: '/tmp/work' }]]);
  });

  it('is false, not a throw, when the lookup itself fails', async () => {
    // A pre-flight that threw would take activation down over a check whose
    // whole purpose is to make activation safer. Falling back to "no session"
    // lands on the fresh-start path, which is what a missing session gets
    // anyway.
    const stub = asGetSessionInfo(async () => {
      throw new Error('session store unreadable');
    });
    expect(await sdkSessionExists('sess-1', '/tmp/work', stub)).toBe(false);
  });
});
