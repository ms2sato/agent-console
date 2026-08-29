/**
 * Tests for the R1 resume pre-flight. The module's whole job is to turn
 * `getSessionInfo`'s three possible outcomes -- a record, `undefined`, or a
 * throw -- into the three values the caller branches on, so these tests are
 * about that mapping and nothing else.
 *
 * The mapping used to be two-valued, and collapsing the throw into the
 * `undefined` case is what let a transient filesystem error look, three
 * layers later, exactly like a session that was genuinely gone. So the
 * assertion that `'error' !== 'not-found'` is the load-bearing one here, not
 * a formality.
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
import type { getSessionInfo, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { probeSdkSession } from '../sdk-session-preflight.js';

/**
 * A real `SDKSessionInfo`, so the stubs below satisfy `typeof getSessionInfo`
 * on their own and this file needs no cast at all. Only the three required
 * fields are meaningful; the module under test never reads any of them --
 * it checks the value against `undefined` and nothing more.
 */
function sessionInfo(sessionId: string): SDKSessionInfo {
  return { sessionId, summary: 'a chat', lastModified: 1_700_000_000_000 };
}

describe('probeSdkSession', () => {
  it("is 'found' when the SDK returns a session record", async () => {
    // Polarity measured: returning `'not-found'` here makes this fail. The
    // pin cannot be satisfied by the function merely not throwing.
    const stub: typeof getSessionInfo = async () => sessionInfo('sess-1');
    expect(await probeSdkSession('sess-1', '/tmp/work', stub)).toBe('found');
  });

  it("is 'not-found' when the SDK returns undefined", async () => {
    const stub: typeof getSessionInfo = async () => undefined;
    expect(await probeSdkSession('sess-gone', '/tmp/work', stub)).toBe('not-found');
  });

  it('passes the cwd as the `dir` hint', async () => {
    // Not cosmetic: without it the SDK searches every project directory on
    // the host instead of this worker's own (measured at 6 ms vs 63 ms on
    // the miss path, which is the path every fresh worker takes).
    const calls: unknown[][] = [];
    const stub: typeof getSessionInfo = async (id, opts) => {
      calls.push([id, opts]);
      return sessionInfo(id);
    };
    await probeSdkSession('sess-1', '/tmp/work', stub);
    expect(calls).toEqual([['sess-1', { dir: '/tmp/work' }]]);
  });

  it("is 'error' -- not a throw and NOT 'not-found' -- when the lookup itself fails", async () => {
    // Two claims in one, and the second is the defect this reason exists for.
    //
    // "Not a throw" is the module's original contract: a pre-flight that
    // threw would take activation down over a check whose whole purpose is
    // to make activation safer.
    //
    // "Not `'not-found'`" is what keeps the server from discarding a
    // perfectly good session id over an unreadable directory. Polarity
    // measured by mutation: reverting the catch arm to `return 'not-found'`
    // leaves every OTHER assertion in this file passing and fails only this
    // line -- so this line, alone, is carrying the fix at this layer.
    const stub: typeof getSessionInfo = async () => {
      throw new Error('session store unreadable');
    };
    const probe = await probeSdkSession('sess-1', '/tmp/work', stub);
    expect(probe).toBe('error');
    expect(probe).not.toBe('not-found');
  });
});
