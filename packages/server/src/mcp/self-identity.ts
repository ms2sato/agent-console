/**
 * Self-identity argument defaulting for MCP tool handlers.
 *
 * Twelve MCP tool arguments in `mcp-server.ts` name a session (and, for six
 * of them, a worker too) that the caller almost always names as itself:
 * "the session/worker this tool call is acting on behalf of". Before this
 * module, every one of those arguments was `z.string()` (required), and the
 * caller restated its own session/worker id on every single call even
 * though a bearer-token-verified caller (`McpCallerIdentity`) already PROVES
 * that identity. `set_agent_parameters` established the precedent this
 * module generalises: its own inline `requestedSessionId ?? caller.sessionId`
 * defaulting plus an explicit own-pair refusal (that tool is migrated onto
 * this module too, so the precedent and its generalisation share one
 * implementation instead of two).
 *
 * This module resolves IDENTITY ONLY. It runs upstream of, and has nothing
 * to do with, AUTHORIZATION: `checkCallerOwnsSession` (does the caller own
 * the resolved session?) and every existing session/worker EXISTENCE check
 * in a tool handler run AFTER this resolves, on the resolved ids -- exactly
 * as they did before this module existed, just fed a resolved id instead of
 * a raw argument.
 *
 * A terminal agent (no bearer token, `getMcpCallerIdentity()` returns
 * `null`) is unaffected as long as it supplies the argument itself: the
 * contract's case 4 below passes the caller-supplied value through
 * unchanged, matching the behavior before this helper existed, exactly.
 *
 * Spec: docs/design/embedded-agent-worker.md "MCP caller identity".
 */
import type { McpCallerIdentity } from './mcp-auth.js';

/**
 * The tool's own argument names, used only to compose error messages (e.g.
 * a tool with `fromSessionId` instead of `sessionId`, or `parentSessionId` /
 * `parentWorkerId`). Defaults to `'sessionId'` / `'workerId'` when omitted.
 */
export interface SelfIdentityArgNames {
  sessionId?: string;
  workerId?: string;
}

export type SelfSessionResolution =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

export type SelfPairResolution =
  | { ok: true; sessionId: string; workerId: string }
  | { ok: false; error: string };

/**
 * Resolve a tool call's session id (and, when the caller asks for it, its
 * worker id too) against the verified MCP caller identity, per the
 * following contract -- applied independently to the session half and (when
 * taken) the worker half, session half first:
 *
 * 1. caller present + argument `undefined` -> the caller's own value.
 * 2. caller present + argument === caller's value -> ok (no-op restatement).
 * 3. caller present + argument !== caller's value -> refused. An EMPTY
 *    STRING is a supplied value like any other: `''` !== the caller's id,
 *    so it is refused as a mismatch rather than silently treated as
 *    "not supplied" (deliberate boundary case).
 * 4. caller absent + argument present (any string, including `''` --
 *    unchanged from before this helper existed; the tool's own downstream
 *    session/worker lookups handle an empty id the same way they always
 *    did) -> the argument, verbatim.
 * 5. caller absent + argument `undefined` -> refused: there is nothing to
 *    default from and nothing the caller supplied.
 *
 * The WORKER half is resolved ONLY when `'workerId' in requested` -- the key
 * present, even with an `undefined` value counts as "this tool call has a
 * worker half". Every call site for a session+worker pair tool passes the
 * literal `{ sessionId, workerId }`; session-only tools pass `{ sessionId }`
 * (or `{ sessionId: someRenamedArg }`) with no `workerId` key at all, so the
 * worker half is never evaluated for them and the result carries no
 * `workerId` field.
 *
 * The session half is evaluated FIRST; when it refuses, the worker half is
 * never looked at and its refusal (if any) is never computed or returned.
 */
export function resolveSelfIdentity(
  caller: McpCallerIdentity | null,
  requested: { sessionId?: string },
  toolName: string,
  argNames?: SelfIdentityArgNames,
): SelfSessionResolution;
export function resolveSelfIdentity(
  caller: McpCallerIdentity | null,
  requested: { sessionId?: string; workerId?: string },
  toolName: string,
  argNames?: SelfIdentityArgNames,
): SelfPairResolution;
export function resolveSelfIdentity(
  caller: McpCallerIdentity | null,
  requested: { sessionId?: string; workerId?: string },
  toolName: string,
  argNames?: SelfIdentityArgNames,
): SelfSessionResolution | SelfPairResolution {
  const sessionArgName = argNames?.sessionId ?? 'sessionId';
  const sessionResult = resolveHalf(caller?.sessionId, requested.sessionId, toolName, sessionArgName, 'session');
  if (!sessionResult.ok) {
    return sessionResult;
  }

  if (!('workerId' in requested)) {
    return { ok: true, sessionId: sessionResult.value };
  }

  const workerArgName = argNames?.workerId ?? 'workerId';
  const workerResult = resolveHalf(caller?.workerId, requested.workerId, toolName, workerArgName, 'worker');
  if (!workerResult.ok) {
    return workerResult;
  }

  return { ok: true, sessionId: sessionResult.value, workerId: workerResult.value };
}

type HalfResolution = { ok: true; value: string } | { ok: false; error: string };

function resolveHalf(
  callerValue: string | undefined,
  requestedValue: string | undefined,
  toolName: string,
  argName: string,
  kind: 'session' | 'worker',
): HalfResolution {
  if (callerValue !== undefined) {
    // Case 1: caller present, argument omitted -> default to the caller's own value.
    if (requestedValue === undefined) {
      return { ok: true, value: callerValue };
    }
    // Case 2: caller present, argument matches -> ok (a no-op restatement).
    // Case 3: caller present, argument mismatches (including '') -> refused.
    if (requestedValue !== callerValue) {
      return {
        ok: false,
        error: `${toolName} can only act as your own ${kind} (token: ${callerValue}); refusing the supplied ${requestedValue}`,
      };
    }
    return { ok: true, value: requestedValue };
  }

  // Case 4: caller absent, argument supplied (any string, including '') -> pass through verbatim.
  if (requestedValue !== undefined) {
    return { ok: true, value: requestedValue };
  }

  // Case 5: caller absent, argument omitted -> nothing to resolve from.
  const hint =
    kind === 'session'
      ? `AGENT_CONSOLE_SESSION_ID in your environment, or the Session ID stated in your system prompt`
      : `AGENT_CONSOLE_WORKER_ID in your environment, or the Worker ID stated in your system prompt`;
  return {
    ok: false,
    error: `${toolName} requires ${argName} for a caller without a bearer token: pass your ${kind} id (${hint})`,
  };
}
