/**
 * MCP caller identity: per-worker bearer tokens and the ownership-check
 * enforcement helper for MCP tool handlers.
 *
 * Spec: docs/design/embedded-agent-worker.md § "MCP caller identity".
 *
 * The `/mcp` endpoint is mounted outside the `/api` auth chain, so tool
 * handlers historically trusted caller-supplied session ids. This module
 * binds MCP tool calls to a verified `{ sessionId, workerId, userId }`
 * identity: the server mints a bearer token per worker, the `/mcp` route
 * resolves the token to an identity via the registry, exposes it to tool
 * handlers through an AsyncLocalStorage seam, and the handlers compare the
 * verified `userId` against the claimed session's `createdBy`.
 */
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createMiddleware } from 'hono/factory';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('mcp-auth');

/**
 * Verified identity of an MCP caller. `userId` is a `users.id` UUID,
 * directly comparable to `Session.createdBy`.
 *
 * This identity is consumed for AUTHORIZATION only, via
 * `checkCallerOwnsSession` ("may this caller act on that session?").
 * Ownership (a delegated session's `createdBy`) deliberately derives from
 * the parent session instead -- never from this identity -- because a
 * fallback to the caller's own identity would silently rescue a caller
 * who omitted `parentSessionId` / `parentWorkerId`, defeating the point
 * of requiring them. In `enforce` mode,
 * `checkCallerOwnsSession`'s mismatch check guarantees this identity's
 * `userId` and the claimed session's `createdBy` already agree whenever
 * both exist, so there is no second source to arbitrate. No code in this
 * codebase should consume `McpCallerIdentity.userId` to derive a
 * session's `createdBy`.
 */
export interface McpCallerIdentity {
  sessionId: string;
  workerId: string;
  userId: string;
}

/**
 * In-memory registry of per-worker MCP bearer tokens.
 *
 * In-memory only BY DESIGN: any live agent process was spawned by the live
 * server, so a server restart kills orphans and re-spawns workers with fresh
 * tokens — tokens never need to survive a restart. A stale token from a
 * kill-escaped process is correctly rejected because it is absent from a
 * fresh registry. Do NOT persist.
 */
export class McpTokenRegistry {
  private tokens = new Map<string, McpCallerIdentity>();

  /** Mint a new bearer token for the given identity and store it. */
  mint(identity: McpCallerIdentity): string {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, identity);
    return token;
  }

  /** Resolve a token to its identity, or null if unknown. */
  verify(token: string): McpCallerIdentity | null {
    return this.tokens.get(token) ?? null;
  }

  /**
   * Revoke every token whose identity targets the given worker.
   *
   * Called on worker exit / kill / delete in later phases; nothing mints or
   * revokes tokens in phase 1.
   */
  revokeByWorker(workerId: string): void {
    for (const [token, identity] of this.tokens) {
      if (identity.workerId === workerId) {
        this.tokens.delete(token);
      }
    }
  }
}

export type McpAuthMode = 'off' | 'warn' | 'enforce';

/**
 * Resolve the effective MCP auth mode from `AGENT_CONSOLE_MCP_AUTH`.
 *
 * - An explicit `off` / `warn` / `enforce` passes through (an operator-set
 *   value always wins, regardless of `AUTH_MODE`) -- EXCEPT explicit
 *   `enforce` combined with a non-multi-user `AUTH_MODE`, which throws (see
 *   Ruling 3 below).
 * - An empty / whitespace-only value is treated as unset (operator-friendly,
 *   same convention as other server-config vars).
 * - Any other non-empty value throws (fail fast at startup — `createMcpApp`
 *   calls this during boot).
 * - Unset resolves to `warn` for every `AUTH_MODE`, including multi-user.
 *   (Sprint 2026-07-16 decision: `enforce`-by-default for multi-user was
 *   never rolled out because the ops cost — existing-session token
 *   re-delivery, Claude Code `headersHelper` per-OS-user wiring, full
 *   dogfood — outweighed the safety benefit for a team-of-trust deployment.
 *   `warn` still logs tokenless callers for observability; operators can opt
 *   into `enforce` explicitly via `AGENT_CONSOLE_MCP_AUTH=enforce`. The
 *   future restoration path is tracked separately.)
 *   (docs/design/embedded-agent-worker.md § "MCP caller identity").
 *
 * Rule 1 of `checkCallerOwnsSession` (a presented-but-mismatched token is
 * always rejected) is unaffected by the default and has been live since
 * phase 1.
 *
 * **`enforce` outside multi-user is a configuration error, not a silent
 * downgrade.** MCP bearer tokens are only ever minted in
 * `AUTH_MODE=multi-user` (`worker-manager.ts`'s mint gate); enforcing
 * against credentials that are never minted would reject every MCP call.
 * Rather than silently downgrading to `warn` (which would hand the operator
 * a false sense of protection), an explicit `AGENT_CONSOLE_MCP_AUTH=enforce`
 * paired with a non-multi-user `AUTH_MODE` throws at startup.
 *
 * This check is scoped to an EXPLICITLY-set `rawValue` only (the raw,
 * pre-trim-emptiness value is non-empty) — it must NEVER fire for a value
 * arrived at by default resolution (the `!trimmed` branch above, which
 * always resolves to `'warn'` regardless of `authMode`). This function does
 * not currently distinguish "explicitly set to warn/off" from "defaulted to
 * warn", so the contradiction check can only be anchored on the `enforce`
 * branch specifically: applying it to the *resolved* value instead would
 * make every single-user deployment fail to start the moment a future
 * default flip promotes `enforce` to the default.
 */
export function resolveMcpAuthMode(
  rawValue: string | undefined = process.env.AGENT_CONSOLE_MCP_AUTH,
  authMode: string | undefined = process.env.AUTH_MODE,
): McpAuthMode {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return 'warn';
  }
  if (trimmed !== 'off' && trimmed !== 'warn' && trimmed !== 'enforce') {
    throw new Error(
      `Invalid AGENT_CONSOLE_MCP_AUTH: '${trimmed}'. Must be 'off', 'warn', or 'enforce'.`,
    );
  }
  if (trimmed === 'enforce' && authMode !== 'multi-user') {
    throw new Error(
      `AGENT_CONSOLE_MCP_AUTH=enforce requires AUTH_MODE=multi-user (got AUTH_MODE=${authMode ?? 'unset'}). ` +
        `MCP bearer tokens are only minted in multi-user mode, so enforcing without it would reject every ` +
        `MCP call. Set AUTH_MODE=multi-user, or use AGENT_CONSOLE_MCP_AUTH=warn (or leave it unset) for ` +
        `single-user deployments.`,
    );
  }
  return trimmed;
}

/**
 * AsyncLocalStorage seam carrying the verified caller identity from the
 * `/mcp` route into tool handlers. The MCP SDK does not thread HTTP context
 * into tool handlers, so ALS is the seam (spec § "MCP caller identity").
 */
export const mcpCallerStorage = new AsyncLocalStorage<McpCallerIdentity | null>();

/** Read the verified caller identity for the current tool invocation. */
export function getMcpCallerIdentity(): McpCallerIdentity | null {
  return mcpCallerStorage.getStore() ?? null;
}

/**
 * Subset of Pino's `Logger` shape that this module uses (`warn` only).
 * Declaring an explicit interface lets tests inject a recording stub without
 * depending on Pino types or `mock.module` — mirrors
 * `ResolveRequestUsernameLogger` in `services/resolve-spawn-username.ts`.
 */
export interface McpAuthLogger {
  warn: (payload: unknown, message: string) => void;
}

/**
 * Resolve the caller identity from the `/mcp` request's Authorization header.
 *
 * - No header → null (tokenless call — the common case today).
 * - Malformed header → warn (payload WITHOUT the header value) and null.
 * - Token present but unknown to the registry → warn (never logging the
 *   token) and null.
 * - Verified → the resolved identity.
 */
export function resolveCallerFromAuthHeader(
  header: string | undefined,
  registry: McpTokenRegistry,
  opts: { logger?: McpAuthLogger } = {},
): McpCallerIdentity | null {
  if (!header) {
    return null;
  }
  const log = opts.logger ?? logger;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    log.warn({}, 'Malformed Authorization header on /mcp; treating as tokenless');
    return null;
  }
  const identity = registry.verify(match[1]);
  if (!identity) {
    log.warn({}, 'Presented MCP bearer token did not verify; treating as tokenless');
    return null;
  }
  return identity;
}

/** The claimed session a tool call operates on (already resolved by the tool). */
export interface ClaimedSession {
  sessionId: string;
  createdBy: string | undefined;
}

/**
 * Enforce that the verified MCP caller owns the claimed session.
 *
 * The spec sketches the signature as `(caller, claimedSessionId, mode)`; this
 * implementation passes the already-resolved `{ sessionId, createdBy }` (tools
 * resolve the session anyway) plus `null` for a tool invoked with no existing
 * session to claim ownership over, keeping the helper pure and
 * `sessionManager`-free. Every current call site resolves a real session
 * first and always passes a non-null `claimed` object, so the `null` branch
 * has no production call site today -- it remains part of the contract for
 * a future tool shaped that way, and is exercised directly by unit tests in
 * `mcp-auth.test.ts`
 * (docs/design/embedded-agent-worker.md § "MCP caller identity").
 *
 * Rules, in order:
 * 1. A presented-and-verified caller is checked against the claimed session
 *    REGARDLESS of mode. A mismatch (including an ownerless/legacy session
 *    whose `createdBy` is undefined — strict fail-closed) is always an error,
 *    never a warning.
 * 2. A tokenless / unverified caller: `off` proceeds (today's behavior),
 *    `warn` logs and proceeds, `enforce` rejects (fail closed).
 */
export function checkCallerOwnsSession(
  caller: McpCallerIdentity | null,
  claimed: ClaimedSession | null,
  mode: McpAuthMode,
  context: { toolName: string },
  opts: { logger?: McpAuthLogger } = {},
): { error: string } | null {
  if (caller) {
    if (claimed === null) {
      return null;
    }
    if (claimed.createdBy !== caller.userId) {
      return {
        error: `MCP caller identity mismatch: the presented token's identity does not own session ${claimed.sessionId} (tool: ${context.toolName})`,
      };
    }
    return null;
  }

  switch (mode) {
    case 'off':
      return null;
    case 'warn': {
      const log = opts.logger ?? logger;
      log.warn(
        { toolName: context.toolName, claimedSessionId: claimed?.sessionId },
        'MCP call without bearer token; proceeding (AGENT_CONSOLE_MCP_AUTH=warn)',
      );
      return null;
    }
    case 'enforce':
      return {
        error: `MCP authentication required: no bearer token presented (AGENT_CONSOLE_MCP_AUTH=enforce, tool: ${context.toolName})`,
      };
  }
}

/**
 * Result of the transport-level authN gate (Ruling 1):
 * `allowed: true` carries the resolved caller (possibly `null`, when the
 * mode is `off`/`warn` and no token was presented) so the caller can be
 * threaded into `mcpCallerStorage`; `allowed: false` carries the rejection
 * message to return as the HTTP response body.
 */
export type McpAuthGateResult =
  | { allowed: true; caller: McpCallerIdentity | null }
  | { allowed: false; error: string };

/**
 * Evaluate the transport-level MCP authN gate (Ruling 1):
 * answers "is this caller anyone at all?" for EVERY `/mcp` request, before
 * any tool dispatch (including `initialize` / `tools/list`). This is a
 * separate, earlier question than `checkCallerOwnsSession`'s authZ check
 * ("does this caller own the claimed session?"), which stays unchanged at
 * its 6 existing call sites.
 *
 * Deliberately takes ONLY the already-resolved caller identity and the
 * mode — no request/header/source-address parameter of any kind — so there
 * is no signal a future "localhost is exempt" patch could key a bypass off
 * of without changing this function's signature (and therefore this
 * decision) explicitly.
 *
 * Rules mirror `checkCallerOwnsSession`'s tokenless branch by design (both
 * implement the same off/warn/enforce mode contract), but are intentionally
 * NOT consolidated with it: `checkCallerOwnsSession` is explicitly retained
 * unchanged per Ruling 1, and the two log a different payload shape /
 * message (this gate has no `toolName` / `claimedSessionId` context to
 * report, since it runs before the request body is known to be a specific
 * tool call).
 */
export function evaluateMcpAuthGate(
  caller: McpCallerIdentity | null,
  mode: McpAuthMode,
  opts: { logger?: McpAuthLogger } = {},
): McpAuthGateResult {
  if (caller) {
    return { allowed: true, caller };
  }

  switch (mode) {
    case 'off':
      return { allowed: true, caller: null };
    case 'warn': {
      const log = opts.logger ?? logger;
      log.warn(
        {},
        'MCP request without verified caller identity; proceeding (AGENT_CONSOLE_MCP_AUTH=warn)',
      );
      return { allowed: true, caller: null };
    }
    case 'enforce':
      return {
        allowed: false,
        error: 'MCP authentication required: no bearer token presented (AGENT_CONSOLE_MCP_AUTH=enforce)',
      };
  }
}

/**
 * Hono middleware factory implementing the transport-level authN gate
 * (Ruling 1). Mounted via `mcpApp.use('/mcp', ...)` in
 * `mcp-server.ts`, this runs for EVERY request to `/mcp` before the sole
 * `.all('/mcp', ...)` dispatch handler -- including `initialize` and
 * `tools/list` -- which is what structurally guarantees a newly-registered
 * `mcpServer.tool(...)` call is covered with zero per-tool wiring: tools are
 * JSON-RPC methods dispatched INSIDE `transport.handleRequest`, not
 * separate Hono routes, so there is exactly one place to gate.
 *
 * On `allowed: true`, wraps `next()` in `mcpCallerStorage.run(caller, ...)`
 * so the downstream handler (and thus every tool body, including the 5
 * existing `checkCallerOwnsSession` call sites reading
 * `getMcpCallerIdentity()`) observes the same caller identity as before —
 * no change to how tools read it.
 */
export function createMcpAuthMiddleware(opts: {
  mcpTokenRegistry: McpTokenRegistry;
  mcpAuthMode: McpAuthMode;
  logger?: McpAuthLogger;
}) {
  return createMiddleware(async (c, next) => {
    const caller = resolveCallerFromAuthHeader(c.req.header('authorization'), opts.mcpTokenRegistry, {
      logger: opts.logger,
    });
    const gate = evaluateMcpAuthGate(caller, opts.mcpAuthMode, { logger: opts.logger });
    if (!gate.allowed) {
      return c.json({ error: gate.error }, 401);
    }
    await mcpCallerStorage.run(gate.caller, () => next());
  });
}
