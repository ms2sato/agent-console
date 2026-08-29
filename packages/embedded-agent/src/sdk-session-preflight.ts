/**
 * Transcript Restore, R1: does the SDK still have the session we are about to
 * ask it to resume?
 *
 * Asking `Options.resume` for a session the SDK cannot find is expensive to
 * get wrong. The refusal does not surface at construction; it surfaces only
 * once a turn is in flight, and it takes the user's first message with it
 * (measured: docs/design/embedded-agent-sdk-engine.md §5, PS6). This check
 * moves that failure to activation time, where it costs a filesystem read
 * and nothing else.
 *
 * **Why this runs in the subprocess and not on the server**, which is the
 * non-obvious part: `getSessionInfo` reads the *calling* OS user's
 * `~/.claude/projects/...`. This subprocess is spawned AS the requesting
 * user, so it reads the right home. The server process is a different user
 * in multi-user mode and would find nothing for every worker but its own --
 * a pre-flight there would silently report "no session" for every
 * multi-user worker and turn every re-activation into a fresh one. This is
 * the same hazard the restore path's server-side instruction loading
 * already carries (see `embedded-agent-worker-service.ts`'s note on
 * `loadInstructions` degrading in multi-user mode); here it is avoidable, so
 * it is avoided.
 *
 * PS7 (§5) is what makes the check safe to act on: it is verified not to
 * report `undefined` for any session shape production actually creates,
 * including a session killed during its first turn with no assistant reply
 * ever produced. The SDK's own contract also allows `undefined` for a
 * session with "no extractable summary", which could not be reproduced but
 * cannot be ruled out -- so this is a pre-flight, not a guarantee, and the
 * refusal path downstream of it stays reachable.
 */
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';

/**
 * True when the SDK can find `sdkSessionId`. Never throws: a pre-flight that
 * failed to run must not take activation down with it -- the caller falls
 * back to a fresh session, which is exactly what it would do for a missing
 * session anyway.
 *
 * `cwd` is passed as the `dir` hint. It does not change any verdict, but it
 * scopes the lookup to this worker's own project directory instead of
 * searching every one on the host (measured: 6 ms vs 63 ms on the miss path).
 */
export async function sdkSessionExists(
  sdkSessionId: string,
  cwd: string,
  // Pay-as-you-go DI seam. Injected rather than mocked at module scope
  // because `mock.module` poisons the whole test process (testing.md
  // Anti-Pattern #2); production callers pass nothing.
  getSessionInfoImpl: typeof getSessionInfo = getSessionInfo,
): Promise<boolean> {
  try {
    return (await getSessionInfoImpl(sdkSessionId, { dir: cwd })) !== undefined;
  } catch (err) {
    console.error(
      `[sdk-session-preflight] getSessionInfo failed for ${sdkSessionId}; treating the session as unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
