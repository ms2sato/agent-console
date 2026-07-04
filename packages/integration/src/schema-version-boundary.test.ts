/**
 * Client-Server Boundary Test: Schema-version handshake + strict wire schemas
 *
 * Covers the three guarantees introduced by the strict-schema / schema-version
 * migration, each exercised through a real code path rather than a mock:
 *
 *  (a) Known-good traffic still flows. A real client API call succeeds through
 *      the fetch bridge, every REST response (2xx and 4xx alike) carries the
 *      `X-Schema-Version` header, and realistic wire messages still parse.
 *  (b) Strict schemas reject unknown fields. The real vValidator + strictObject
 *      rejects an extra REST field with HTTP 400, and the client-side
 *      AppServerMessageSchema rejects extra WebSocket fields at any depth.
 *  (c) A version drift forces exactly one client reload, then degrades to a
 *      manual-refresh state, using the real client fetch inspector end-to-end.
 *
 * The server middleware is mounted in a thin wrapper Hono app that mirrors the
 * production wiring in packages/server/src/index.ts (`app.use('*',
 * schemaVersionHeaderMiddleware)`), so the header is produced by the real
 * middleware, not a test replica.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';

import { SCHEMA_VERSION, AppServerMessageSchema } from '@agent-console/shared';

// Import test utilities from the server package (Server Bridge Pattern).
import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';

// Real production middleware + its header name (single source of truth).
import {
  schemaVersionHeaderMiddleware,
  SCHEMA_VERSION_HEADER,
} from '@agent-console/server/src/middleware/schema-version-header';

// Real SQLite repository so GET/POST exercise the full server stack.
import { SqliteMessageTemplateRepository } from '@agent-console/server/src/repositories/sqlite-message-template-repository';
import { initializeDatabase } from '@agent-console/server/src/database/connection';

// Real client API function (a simple GET) for the end-to-end success path.
import { fetchMessageTemplates } from '@agent-console/client/src/lib/api';

// Real client-side schema-version handshake module under test.
import {
  installSchemaVersionFetchInspector,
  getMismatch,
  _reset,
  _setReloadImpl,
  _simulateReload,
} from '@agent-console/client/src/lib/schema-version';

import { createFetchBridge } from './test-utils';

/**
 * Mirrors the private RELOAD_GUARD_KEY constant in
 * packages/client/src/lib/schema-version.ts. Kept in sync by hand; the
 * behavioral "no second reload" assertion in group (c) is the primary proof
 * that the guard persisted, this literal is only a convenience check.
 */
const RELOAD_GUARD_KEY = 'agent-console:schema-version-reload-attempted';

/** A server version that is deliberately different from this bundle's. */
const DRIFTED_VERSION = 'drifted-server-version-0000';

// === Reusable realistic wire fixtures (shapes mirror the server broadcast) ===

const worktreeSession = {
  type: 'worktree' as const,
  id: 'session-1',
  locationPath: '/path/to/worktree',
  status: 'active' as const,
  activationState: 'running' as const,
  createdAt: '2026-01-01T00:00:00Z',
  workers: [],
  repositoryId: 'repo-1',
  repositoryName: 'my-repo',
  worktreeId: 'feature-branch',
  isMainWorktree: false,
  isShared: false,
  recoveryState: 'healthy' as const,
};

describe('Client-Server Boundary: Schema-version handshake + strict schemas', () => {
  let app: Hono;
  let bridge: ReturnType<typeof createFetchBridge>;

  beforeEach(async () => {
    await setupTestEnvironment();

    const db = await initializeDatabase(':memory:');
    const messageTemplateRepository = new SqliteMessageTemplateRepository(db);

    // Wrap the routed test app with the real schema-version header middleware,
    // reproducing the production mount order from index.ts.
    const inner = await createTestApp({ messageTemplateRepository });
    app = new Hono();
    app.use('*', schemaVersionHeaderMiddleware);
    app.route('/', inner);

    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    // Reset the client handshake module state (also clears the reload guard)
    // and wipe sessionStorage so groups do not leak into each other.
    _reset();
    try {
      window.sessionStorage.clear();
    } catch {
      // sessionStorage may be unavailable in some environments; ignore.
    }
    await cleanupTestEnvironment();
  });

  // ===========================================================================
  // (a) Known-good payloads: valid traffic must keep flowing end-to-end.
  // ===========================================================================
  describe('known-good payloads (regression guard for valid traffic)', () => {
    it('a real client GET succeeds end-to-end through the bridge', async () => {
      const result = await fetchMessageTemplates();
      expect(result.templates).toEqual([]);
    });

    it('a 2xx REST response carries X-Schema-Version equal to SCHEMA_VERSION', async () => {
      const response = await fetch('/api/message-templates', { method: 'GET' });
      expect(response.status).toBe(200);
      expect(response.headers.get(SCHEMA_VERSION_HEADER)).toBe(SCHEMA_VERSION);
    });

    it('a 4xx REST response still carries the header (middleware runs before the error)', async () => {
      // A validation failure (missing required fields) produces HTTP 400 from
      // the real error handler; the header set before `next()` must survive.
      const response = await fetch('/api/message-templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get(SCHEMA_VERSION_HEADER)).toBe(SCHEMA_VERSION);
    });

    it('decodes a schema-version wire message via AppServerMessageSchema', () => {
      const parsed = v.safeParse(AppServerMessageSchema, {
        type: 'schema-version',
        version: SCHEMA_VERSION,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.output.type === 'schema-version') {
        expect(parsed.output.version).toBe(SCHEMA_VERSION);
      } else {
        throw new Error('schema-version message failed to parse');
      }
    });

    it('decodes a realistic sessions-sync wire message via AppServerMessageSchema', () => {
      const parsed = v.safeParse(AppServerMessageSchema, {
        type: 'sessions-sync',
        sessions: [worktreeSession],
        activityStates: [
          { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
        ],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.output.type === 'sessions-sync') {
        expect(parsed.output.sessions).toHaveLength(1);
        expect(parsed.output.sessions[0].id).toBe('session-1');
      } else {
        throw new Error('sessions-sync message failed to parse');
      }
    });
  });

  // ===========================================================================
  // (b) Extra-field rejection: the polarity-critical new strict behavior.
  // ===========================================================================
  describe('extra-field rejection (strict schemas)', () => {
    it('REST: POST with an unknown extra field is rejected with HTTP 400', async () => {
      const response = await fetch('/api/message-templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `unexpected` is not part of CreateMessageTemplateRequestSchema.
        body: JSON.stringify({ title: 'Greeting', content: 'Hello', unexpected: 'x' }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      // The strictObject rejection names the offending key.
      expect(body.error).toContain('unexpected');
    });

    it('WS: a top-level extra field fails AppServerMessageSchema and names the key', () => {
      const parsed = v.safeParse(AppServerMessageSchema, {
        type: 'session-deleted',
        sessionId: 'session-1',
        bogus: 1,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(JSON.stringify(parsed.issues)).toContain('bogus');
      }
    });

    it('WS: a nested extra field inside a session fails (strictness is deep)', () => {
      const parsed = v.safeParse(AppServerMessageSchema, {
        type: 'sessions-sync',
        // Extra key buried inside a session object, not at the envelope level.
        sessions: [{ ...worktreeSession, sneaky: 'x' }],
        activityStates: [],
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(JSON.stringify(parsed.issues)).toContain('sneaky');
      }
    });
  });

  // ===========================================================================
  // (c) Version drift -> reload guard, exercised through the real inspector.
  // ===========================================================================
  describe('version mismatch reload guard (client inspector end-to-end)', () => {
    /**
     * Layer a header-rewriting fetch on top of the already-installed bridge,
     * then install the real client inspector on top of that. The rewriter lets
     * a test simulate a deployed server on a different schema version without
     * mutating the compiled server constant.
     *
     * @param overrideVersion the value to force into X-Schema-Version, or null
     *   to pass the real middleware header through untouched.
     */
    function installInspectorWithHeader(overrideVersion: string | null): void {
      const underlying = globalThis.fetch;
      globalThis.fetch = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ): Promise<Response> => {
        const res = await underlying(input, init);
        if (overrideVersion === null) return res;
        // Fully consume and rebuild so the returned Response is readable and
        // carries the drifted header.
        const text = await res.text();
        const headers = new Headers(res.headers);
        headers.set(SCHEMA_VERSION_HEADER, overrideVersion);
        return new Response(text, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }) as typeof globalThis.fetch;

      installSchemaVersionFetchInspector();
    }

    it('a mismatched server version triggers exactly one reload and persists the guard', async () => {
      _reset();
      window.sessionStorage.clear();
      const reloadMock = mock(() => {});
      _setReloadImpl(reloadMock);
      installInspectorWithHeader(DRIFTED_VERSION);

      await fetch('/api/message-templates', { method: 'GET' });

      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe(DRIFTED_VERSION);

      // A second response within the same page load must NOT reload again
      // (the per-load flag short-circuits until the navigation completes).
      await fetch('/api/message-templates', { method: 'GET' });
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('after a simulated reload with the same version, it stops reloading and degrades', async () => {
      _reset();
      window.sessionStorage.clear();
      const reloadMock = mock(() => {});
      _setReloadImpl(reloadMock);
      installInspectorWithHeader(DRIFTED_VERSION);

      // First load: reload once, guard now records the drifted version.
      await fetch('/api/message-templates', { method: 'GET' });
      expect(reloadMock).toHaveBeenCalledTimes(1);

      // Model the page-load boundary the reload would have caused.
      _simulateReload();

      // Same mismatch persists after the reload -> stop reloading, degrade.
      await fetch('/api/message-templates', { method: 'GET' });
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(getMismatch()).toBe(true);
    });

    it('a matching server version clears the guard and does not reload', async () => {
      _reset();
      window.sessionStorage.clear();
      // Pre-seed a stale guard to prove a matching response clears it.
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, 'stale-old-version');
      const reloadMock = mock(() => {});
      _setReloadImpl(reloadMock);
      // Pass the real middleware header through: it equals SCHEMA_VERSION.
      installInspectorWithHeader(null);

      await fetch('/api/message-templates', { method: 'GET' });

      expect(reloadMock).not.toHaveBeenCalled();
      expect(getMismatch()).toBe(false);
      expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull();
    });
  });
});
