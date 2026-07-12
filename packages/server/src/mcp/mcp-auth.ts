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
import { createLogger } from '../lib/logger.js';

const logger = createLogger('mcp-auth');

/**
 * Verified identity of an MCP caller. `userId` is a `users.id` UUID,
 * directly comparable to `Session.createdBy`.
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
 *   value always wins, regardless of `AUTH_MODE`).
 * - An empty / whitespace-only value is treated as unset (operator-friendly,
 *   same convention as other server-config vars).
 * - Any other non-empty value throws (fail fast at startup — `createMcpApp`
 *   calls this during boot).
 * - Unset resolves to `enforce` when `AUTH_MODE=multi-user` (Phase 4,
 *   landed), `warn` otherwise (including single-user mode, where the gap is
 *   operationally moot)
 *   (docs/design/embedded-agent-worker.md § "MCP caller identity").
 *
 * Rule 1 of `checkCallerOwnsSession` (a presented-but-mismatched token is
 * always rejected) is unaffected by the default and has been live since
 * phase 1.
 */
export function resolveMcpAuthMode(
  rawValue: string | undefined = process.env.AGENT_CONSOLE_MCP_AUTH,
  authMode: string | undefined = process.env.AUTH_MODE,
): McpAuthMode {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return authMode === 'multi-user' ? 'enforce' : 'warn';
  }
  if (trimmed !== 'off' && trimmed !== 'warn' && trimmed !== 'enforce') {
    throw new Error(
      `Invalid AGENT_CONSOLE_MCP_AUTH: '${trimmed}'. Must be 'off', 'warn', or 'enforce'.`,
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
 * resolve the session anyway) plus `null` for tools invoked without a claimed
 * session (e.g. `delegate_to_worktree` without `parentSessionId`), keeping the
 * helper pure and `sessionManager`-free
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
