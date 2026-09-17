/**
 * `resolveSelfIdentity` unit tests (Issue #1696).
 *
 * Pure unit tests against the exported function only -- no MCP transport,
 * no SessionManager. `mcp-server.test.ts` / `set-agent-parameters.test.ts` /
 * `create-bookmark.test.ts` etc. cover the wired-in behavior end to end;
 * this file is the single place that exhaustively covers the five-case
 * contract per half plus the boundary values.
 *
 * ---------------------------------------------------------------------
 * Mutation reach (measured, not predicted -- workflow.md "A check's
 * existence is not its detection power"). Each mutation was applied to
 * self-identity.ts, `bun test src/mcp/__tests__/self-identity.test.ts` was
 * run from packages/server, the failing tests were recorded below verbatim
 * from the run's output, and the mutation was reverted (confirmed via
 * `git diff packages/server/src/mcp/self-identity.ts` showing no changes).
 *
 * - M1 (drop the mismatch branch -- case 3 falls through to "accept the
 *   supplied value"): fails 9 tests: "session half > caller present,
 *   argument mismatches -> refused (case 3)", "session half > caller
 *   present, argument is an empty string -> refused as a mismatch, not
 *   defaulted (boundary)", "worker half > caller present, argument
 *   mismatches -> refused (case 3)", "worker half > caller present, argument
 *   is an empty string -> refused as a mismatch, not defaulted (boundary)",
 *   "the session refusal wins when both halves mismatch", "message shapes
 *   (exact strings) > case 3, session half, default arg name", "message
 *   shapes (exact strings) > case 3, worker half, default arg name",
 *   "message shapes (exact strings) > custom argNames > case 3 message
 *   names the custom session arg via the identity sentence unchanged (only
 *   argName affects case-5 text)", "message shapes (exact strings) > custom
 *   argNames > case 3 message names the custom worker arg (parentWorkerId)
 *   via the identity sentence unchanged".
 * - M2 (case 5 defaults to '' instead of refusing): fails 6 tests: "session
 *   half > caller absent, argument omitted -> refused (case 5)", "worker
 *   half > caller absent, argument omitted -> refused (case 5)", "message
 *   shapes (exact strings) > case 5, session half, default arg name",
 *   "message shapes (exact strings) > case 5, worker half, default arg
 *   name", "message shapes (exact strings) > custom argNames > case 5
 *   message names the custom session arg (fromSessionId)", "message shapes
 *   (exact strings) > custom argNames > case 5 message names the custom
 *   worker arg (parentWorkerId)".
 * - M3 (swap the order so the worker half is evaluated first): fails 1
 *   test: "the session refusal wins when both halves mismatch" (the only
 *   test that distinguishes evaluation order -- every other test uses a
 *   single-mismatch or single-omission fixture that produces the same
 *   verdict regardless of which half runs first).
 * - M4 (resolve the worker half even when `workerId` is not in `requested`):
 *   fails 5 tests, not the 2 originally predicted -- every session-only
 *   fixture is affected, not just the one that asserts absence of a
 *   `workerId` key: "session half > caller present, argument omitted ->
 *   defaults to caller value (case 1)" and "session half > caller present,
 *   argument matches -> ok (case 2)" fail because the exact `toEqual` now
 *   sees an unexpected `workerId` key (caller present, so the worker half
 *   silently resolves to the caller's own worker rather than erroring);
 *   "session half > caller absent, argument present -> passes through
 *   verbatim (case 4)" and "session half > caller absent, argument is an
 *   empty string -> still passed through (case 4, unchanged legacy
 *   behavior)" fail because with no caller AND no `workerId` key, the
 *   mutated code now evaluates the worker half as case 5 (both sides
 *   undefined) and refuses the whole call; "session-only vs pair
 *   discrimination > a session-only request with no caller resolves
 *   without any worker refusal and the result has no workerId key" fails
 *   the same way. The corrected reach count replaces the earlier
 *   under-count.
 * ---------------------------------------------------------------------
 */
import { describe, it, expect } from 'bun:test';
import { resolveSelfIdentity } from '../self-identity.js';
import type { McpCallerIdentity } from '../mcp-auth.js';

const caller: McpCallerIdentity = {
  sessionId: 'caller-session',
  workerId: 'caller-worker',
  userId: 'caller-user',
};

describe('resolveSelfIdentity', () => {
  describe('session half', () => {
    it('caller present, argument omitted -> defaults to caller value (case 1)', () => {
      const result = resolveSelfIdentity(caller, { sessionId: undefined }, 'my_tool');
      expect(result).toEqual({ ok: true, sessionId: 'caller-session' });
    });

    it('caller present, argument matches -> ok (case 2)', () => {
      const result = resolveSelfIdentity(caller, { sessionId: 'caller-session' }, 'my_tool');
      expect(result).toEqual({ ok: true, sessionId: 'caller-session' });
    });

    it('caller present, argument mismatches -> refused (case 3)', () => {
      const result = resolveSelfIdentity(caller, { sessionId: 'other-session' }, 'my_tool');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('can only act as your own session');
        expect(result.error).toContain('caller-session');
        expect(result.error).toContain('other-session');
      }
    });

    it('caller present, argument is an empty string -> refused as a mismatch, not defaulted (boundary)', () => {
      const result = resolveSelfIdentity(caller, { sessionId: '' }, 'my_tool');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('refusing the supplied ');
        expect(result.error).toContain('caller-session');
      }
    });

    it('caller absent, argument present -> passes through verbatim (case 4)', () => {
      const result = resolveSelfIdentity(null, { sessionId: 'terminal-session' }, 'my_tool');
      expect(result).toEqual({ ok: true, sessionId: 'terminal-session' });
    });

    it('caller absent, argument is an empty string -> still passed through (case 4, unchanged legacy behavior)', () => {
      const result = resolveSelfIdentity(null, { sessionId: '' }, 'my_tool');
      expect(result).toEqual({ ok: true, sessionId: '' });
    });

    it('caller absent, argument omitted -> refused (case 5)', () => {
      const result = resolveSelfIdentity(null, { sessionId: undefined }, 'my_tool');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('requires sessionId for a caller without a bearer token');
      }
    });
  });

  describe('worker half', () => {
    it('caller present, argument omitted -> defaults to caller value (case 1)', () => {
      const result = resolveSelfIdentity(caller, { sessionId: 'caller-session', workerId: undefined }, 'my_tool');
      expect(result).toEqual({ ok: true, sessionId: 'caller-session', workerId: 'caller-worker' });
    });

    it('caller present, argument matches -> ok (case 2)', () => {
      const result = resolveSelfIdentity(
        caller,
        { sessionId: 'caller-session', workerId: 'caller-worker' },
        'my_tool',
      );
      expect(result).toEqual({ ok: true, sessionId: 'caller-session', workerId: 'caller-worker' });
    });

    it('caller present, argument mismatches -> refused (case 3)', () => {
      const result = resolveSelfIdentity(
        caller,
        { sessionId: 'caller-session', workerId: 'other-worker' },
        'my_tool',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('can only act as your own worker');
        expect(result.error).toContain('caller-worker');
        expect(result.error).toContain('other-worker');
      }
    });

    it('caller present, argument is an empty string -> refused as a mismatch, not defaulted (boundary)', () => {
      const result = resolveSelfIdentity(caller, { sessionId: 'caller-session', workerId: '' }, 'my_tool');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('refusing the supplied ');
        expect(result.error).toContain('caller-worker');
      }
    });

    it('caller absent, argument present -> passes through verbatim (case 4)', () => {
      const result = resolveSelfIdentity(
        null,
        { sessionId: 'terminal-session', workerId: 'terminal-worker' },
        'my_tool',
      );
      expect(result).toEqual({ ok: true, sessionId: 'terminal-session', workerId: 'terminal-worker' });
    });

    it('caller absent, argument omitted -> refused (case 5)', () => {
      const result = resolveSelfIdentity(
        null,
        { sessionId: 'terminal-session', workerId: undefined },
        'my_tool',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('requires workerId for a caller without a bearer token');
      }
    });
  });

  describe('session-only vs pair discrimination', () => {
    it('a session-only request with no caller resolves without any worker refusal and the result has no workerId key', () => {
      const result = resolveSelfIdentity(null, { sessionId: 'a' }, 'my_tool');
      expect(result).toEqual({ ok: true, sessionId: 'a' });
      expect('workerId' in result).toBe(false);
    });

    it('a pair request with a caller resolves both', () => {
      const result = resolveSelfIdentity(caller, { sessionId: undefined, workerId: undefined }, 'my_tool');
      expect(result).toEqual({ ok: true, sessionId: 'caller-session', workerId: 'caller-worker' });
    });
  });

  it('the session refusal wins when both halves mismatch', () => {
    const result = resolveSelfIdentity(
      caller,
      { sessionId: 'other-session', workerId: 'other-worker' },
      'my_tool',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('can only act as your own session');
      expect(result.error).not.toContain('can only act as your own worker');
    }
  });

  describe('message shapes (exact strings)', () => {
    it('case 3, session half, default arg name', () => {
      const result = resolveSelfIdentity(caller, { sessionId: 'other-session' }, 'my_tool');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          'my_tool can only act as your own session (token: caller-session); refusing the supplied other-session',
        );
      }
    });

    it('case 3, worker half, default arg name', () => {
      const result = resolveSelfIdentity(
        caller,
        { sessionId: 'caller-session', workerId: 'other-worker' },
        'my_tool',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          'my_tool can only act as your own worker (token: caller-worker); refusing the supplied other-worker',
        );
      }
    });

    it('case 5, session half, default arg name', () => {
      const result = resolveSelfIdentity(null, { sessionId: undefined }, 'my_tool');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          'my_tool requires sessionId for a caller without a bearer token: pass your session id ' +
            '(AGENT_CONSOLE_SESSION_ID in your environment, or the Session ID stated in your system prompt)',
        );
      }
    });

    it('case 5, worker half, default arg name', () => {
      const result = resolveSelfIdentity(
        null,
        { sessionId: 'terminal-session', workerId: undefined },
        'my_tool',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          'my_tool requires workerId for a caller without a bearer token: pass your worker id ' +
            '(AGENT_CONSOLE_WORKER_ID in your environment, or the Worker ID stated in your system prompt)',
        );
      }
    });

    describe('custom argNames', () => {
      it('case 3 message names the custom session arg via the identity sentence unchanged (only argName affects case-5 text)', () => {
        const result = resolveSelfIdentity(
          caller,
          { sessionId: 'other-session' },
          'send_session_message',
          { sessionId: 'fromSessionId' },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe(
            'send_session_message can only act as your own session (token: caller-session); refusing the supplied other-session',
          );
        }
      });

      it('case 5 message names the custom session arg (fromSessionId)', () => {
        const result = resolveSelfIdentity(null, { sessionId: undefined }, 'send_session_message', {
          sessionId: 'fromSessionId',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe(
            'send_session_message requires fromSessionId for a caller without a bearer token: pass your session id ' +
              '(AGENT_CONSOLE_SESSION_ID in your environment, or the Session ID stated in your system prompt)',
          );
        }
      });

      it('case 5 message names the custom worker arg (parentWorkerId)', () => {
        const result = resolveSelfIdentity(
          null,
          { sessionId: 'parent-session', workerId: undefined },
          'delegate_to_worktree',
          { sessionId: 'parentSessionId', workerId: 'parentWorkerId' },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe(
            'delegate_to_worktree requires parentWorkerId for a caller without a bearer token: pass your worker id ' +
              '(AGENT_CONSOLE_WORKER_ID in your environment, or the Worker ID stated in your system prompt)',
          );
        }
      });

      it('case 3 message names the custom worker arg (parentWorkerId) via the identity sentence unchanged', () => {
        const result = resolveSelfIdentity(
          caller,
          { sessionId: 'caller-session', workerId: 'other-worker' },
          'delegate_to_worktree',
          { sessionId: 'parentSessionId', workerId: 'parentWorkerId' },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe(
            'delegate_to_worktree can only act as your own worker (token: caller-worker); refusing the supplied other-worker',
          );
        }
      });
    });
  });
});
