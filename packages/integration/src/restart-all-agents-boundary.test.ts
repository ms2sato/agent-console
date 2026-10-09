/**
 * Client-Server Boundary Test: POST /api/sessions/restart-all-agents
 * (Issue #1519)
 *
 * `packages/client/src/lib/api.ts`'s `RestartAllAgentsResult` interface is
 * NOT imported from `packages/server` or `packages/shared` -- it is a
 * separately hand-written interface kept in sync with
 * `SessionManager.restartAllAgentWorkers`'s return shape by convention only.
 * There is no valibot schema on this route (unlike the WebSocket app-message
 * boundary `created-by-username-boundary.test.ts` guards), so nothing
 * mechanically catches future drift between the two independently-maintained
 * definitions -- not even a schema that could silently strip a field. This
 * is the same genre of regression `pre-pr-completeness.md` Q10 exists for (a
 * wire-crossing shape change with zero integration coverage, caught only by
 * manual QA hours later in the PR #926 incident), with the schema layer
 * removed from the picture entirely: the risk here is plain shape drift, not
 * a strict-schema field drop.
 *
 * This boundary test exercises the real chain:
 *   real HTTP POST /api/sessions/restart-all-agents
 *     -> real route handler (packages/server/src/routes/sessions.ts)
 *     -> real SessionManager.restartAllAgentWorkers()
 *     -> real c.json() serialization
 *     -> res.json() deserialization (the same call the client's
 *        restartAllAgentWorkers() in packages/client/src/lib/api.ts makes)
 *
 * and pins the specific property this Issue is about: a "no targets"
 * scenario and an "all skipped" scenario must produce DISTINGUISHABLE JSON
 * responses -- specifically that `skipped` differs (0 vs >0) and that
 * per-entry `outcome`/`workerType` fields survive the round trip un-mangled.
 * If a future change silently reverted to the old `{ success: boolean }`
 * per-entry shape, or dropped the `skipped` counter entirely, the second
 * test's field-presence assertions fail.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/)
 * -- see test-trigger.md's documented exception for this package.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { SignJWT } from 'jose';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { CLAUDE_SDK_AGENT_ID } from '@agent-console/server/src/services/embedded-agent-manager';
import { MultiUserMode } from '@agent-console/server/src/services/user-mode';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SqliteSessionRepository } from '@agent-console/server/src/repositories/sqlite-session-repository';
import { getConfigDir } from '@agent-console/server/src/lib/config';
import { serverConfig } from '@agent-console/server/src/lib/server-config';
import { AUTH_COOKIE_NAME } from '@agent-console/server/src/lib/auth-constants';

/**
 * Mirrors `packages/client/src/lib/api.ts`'s `RestartAllAgentsResult`
 * exactly. Not imported from there: the client package is not a valid
 * import target from `packages/integration` in this repo's module
 * resolution setup (the client is a Vite app, not a library package
 * exporting types for consumption -- unlike `@agent-console/server` and
 * `@agent-console/shared`, which this file already imports from). The
 * fields below are asserted individually against the real wire response
 * rather than validated via this local type, so this interface exists only
 * to document the shape this test pins, not to perform any runtime check.
 */
interface RestartAllAgentsResult {
  restarted: number;
  failed: number;
  skipped: number;
  results: Array<{
    sessionId: string;
    workerId: string;
    workerType: 'agent' | 'terminal' | 'embedded-agent';
    outcome: 'restarted' | 'failed' | 'skipped';
    error?: string;
  }>;
}

describe('Client-Server Boundary: POST /api/sessions/restart-all-agents', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    // Issue #1886: hermetic PtyProvider -- this suite's fixture cwd does not
    // exist on disk, and the configured default (bun-terminal) throws
    // ENOENT on a missing cwd where the legacy bunPtyProvider silently
    // tolerated it (production handling tracked separately, #1892).
    // This file's locationPath literal isn't seeded on real/mocked fs and this
    // test doesn't exercise the cwd-existence check itself (Issue #1892).
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider(), assertSpawnCwdFn: async () => {} });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('returns a zeroed, empty-results shape when no sessions exist (no targets)', async () => {
    const app = await createTestApp(ctx);

    const res = await app.request('/api/sessions/restart-all-agents', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RestartAllAgentsResult;
    expect(body.restarted).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.results).toEqual([]);
  });

  it('reports terminal + dormant embedded-agent workers as skipped, distinguishably from the no-targets response', async () => {
    // 1. Seed a user so createSession satisfies the created_by FK.
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

    // 2. A session whose initial worker is embedded-agent, NEVER activated
    //    (dormant): restart-all must skip it rather than reactivate it
    //    (reactivating a dormant worker would defeat idle eviction's point).
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', embeddedAgentId: CLAUDE_SDK_AGENT_ID },
      { createdBy: owner.id },
    );
    const embeddedWorker = session.workers.find((w) => w.type === 'embedded-agent');
    if (!embeddedWorker) throw new Error('expected an embedded-agent initial worker');

    // 3. Add a terminal worker to the same session: always skipped,
    //    regardless of activation state.
    const terminalWorker = await ctx.sessionManager.createWorker(session.id, {
      type: 'terminal',
      name: 'Shell',
    });
    if (!terminalWorker) throw new Error('createWorker returned null for the terminal worker');

    // 4. Drive the REAL route via the real Hono app -- exercises the actual
    //    c.json() / res.json() wire step, not an in-process method call.
    const app = await createTestApp(ctx);
    const res = await app.request('/api/sessions/restart-all-agents', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RestartAllAgentsResult;

    expect(body.restarted).toBe(0);
    expect(body.failed).toBe(0);
    // The property this Issue is about: distinguishable from the
    // "no targets" scenario's `skipped: 0` above.
    expect(body.skipped).toBe(2);
    expect(body.skipped).not.toBe(0);
    expect(body.results).toHaveLength(2);

    const embeddedEntry = body.results.find((r) => r.workerId === embeddedWorker.id);
    expect(embeddedEntry).toEqual({
      sessionId: session.id,
      workerId: embeddedWorker.id,
      workerType: 'embedded-agent',
      outcome: 'skipped',
    });

    const terminalEntry = body.results.find((r) => r.workerId === terminalWorker.id);
    expect(terminalEntry).toEqual({
      sessionId: session.id,
      workerId: terminalWorker.id,
      workerType: 'terminal',
      outcome: 'skipped',
    });
  });

  // ===========================================================================
  // Authorization boundary (Issue #1555): two authenticated users, real JWT
  // cookies through the real MultiUserMode / authMiddleware chain. Per
  // pre-pr-completeness.md Q13's "genuinely provisioned" proxy rule, the
  // JWTs are minted the same way MultiUserMode.login() mints them (same
  // SignJWT call shape, same claims), against a known secret written to the
  // config dir's jwt-secret file BEFORE MultiUserMode.create() is called --
  // mirrors multi-user-mode.test.ts's "should load an existing JWT secret
  // file" recipe -- rather than a hand-written AuthUser object bypassing the
  // auth middleware.
  // ===========================================================================
  it('scopes the real route to the authenticated caller: alice may not restart bob\'s session', async () => {
    const originalAuthMode = serverConfig.AUTH_MODE;
    (serverConfig as { AUTH_MODE: string }).AUTH_MODE = 'multi-user';

    try {
      // 1. Write a known JWT secret BEFORE MultiUserMode.create() loads it,
      //    so this test can sign tokens that verify against the same secret
      //    the running MultiUserMode instance uses.
      const knownSecret = new Uint8Array(32).fill(7);
      const fs = await import('fs/promises');
      await fs.writeFile(`${getConfigDir()}/jwt-secret`, Buffer.from(knownSecret));

      // 2. A MOCK PtyProvider here means MultiUserMode.spawnSudoPty's
      //    `this.ptyProvider.spawn('sudo', argv, ...)` call never reaches a
      //    real `sudo` binary -- the elevation decision still runs (alice's
      //    and bob's usernames differ from the server process user), but
      //    the spawn itself is entirely fake.
      const multiUserMode = await MultiUserMode.create(createMockPtyProvider(), ctx.userRepository);

      // 3. SessionManager/WorkerManager close over the userMode instance
      //    they were constructed with (agent-parameter-worktree-boundary.
      //    test.ts's documented pattern) -- rebuild it, reusing every other
      //    real ctx collaborator, so only the userMode seam differs from
      //    what createTestContext built by default.
      ctx.userMode = multiUserMode;
      ctx.sessionManager = await SessionManager.create({
        userMode: multiUserMode,
        userRepository: ctx.userRepository,
        sessionRepository: new SqliteSessionRepository(ctx.db),
        jobQueue: ctx.jobQueue,
        agentManager: ctx.agentManager,
        embeddedAgentManager: ctx.embeddedAgentManager,
        mcpTokenRegistry: ctx.mcpTokenRegistry,
        notificationManager: ctx.notificationManager,
        annotationService: ctx.annotationService,
        interSessionMessageService: ctx.interSessionMessageService,
        repositoryLookup: {
          getRepositorySlug: (id) => ctx.repositoryManager.getRepositorySlug(id),
        },
        repositoryEnvLookup: {
          getRepositoryInfo: (id) => {
            const r = ctx.repositoryManager.getRepository(id);
            return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
          },
          getWorktreeIndexNumber: (path) => ctx.worktreeService.getWorktreeIndexNumber(path),
        },
        pathExists: async () => true,
      });

      // 4. Two real users, upserted via the real UserRepository (satisfies
      //    sessions.created_by's FK).
      const alice = await ctx.userRepository.upsertByOsUid(9501, 'alice', '/home/alice');
      const bob = await ctx.userRepository.upsertByOsUid(9502, 'bob', '/home/bob');

      // 5. One session per user, each with a live PTY-backed agent worker.
      const sessionA = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code' },
        { createdBy: alice.id },
      );
      const sessionB = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path2', agentId: 'claude-code' },
        { createdBy: bob.id },
      );

      // 6. Mint alice's JWT the same way MultiUserMode.login() does.
      const aliceToken = await new SignJWT({ username: alice.username, home: alice.homeDir })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(alice.id)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(knownSecret);

      const restartSpy = spyOn(ctx.sessionManager, 'restartAgentWorker');

      const app = await createTestApp(ctx);
      // NOTE: `Cookie` is a forbidden header name under the Fetch spec, and
      // this package's `--preload ./src/setup.ts` registers happy-dom's
      // GlobalRegistrator globally for every test file -- happy-dom's
      // `Request` constructor enforces that restriction and silently drops
      // a `Cookie` entry passed via `init.headers` (confirmed: `new
      // Request(url, { headers: { Cookie: '...' } }).headers.get('cookie')`
      // is `null` under this preload, `'...'` without it). Hono's own
      // `app.request(input, requestInit)` only re-wraps `input` in a fresh
      // `new Request(...)` when a second `requestInit` argument is passed;
      // called with a single, already-built `Request` argument it forwards
      // that instance to `fetch()` unchanged (hono-base.js's `request`).
      // So: build the Request with no cookie in its init, then mutate its
      // (unguarded, post-construction) `headers` via `.set()` -- which is
      // NOT subject to the same forbidden-header check -- and pass that one
      // Request instance, with no second argument, to `app.request()`.
      const req = new Request('http://localhost/api/sessions/restart-all-agents', { method: 'POST' });
      req.headers.set('cookie', `${AUTH_COOKIE_NAME}=${aliceToken}`);
      const res = await app.request(req);

      expect(res.status).toBe(200);
      const body = (await res.json()) as RestartAllAgentsResult;

      // Absence, not a `skipped` outcome: bob's session/worker must not
      // appear in the response at all.
      expect(body.results.some((r) => r.sessionId === sessionA.id)).toBe(true);
      expect(body.results.some((r) => r.sessionId === sessionB.id)).toBe(false);

      expect(restartSpy.mock.calls.some((call) => call[0] === sessionA.id)).toBe(true);
      expect(restartSpy.mock.calls.every((call) => call[0] !== sessionB.id)).toBe(true);

      // POLARITY (Issue #1555): run this same test against the route with
      // its `{ kind: 'operableBy', userId: authUser.id }` scoping removed
      // (reverted to the old unscoped `sessionManager.restartAllAgentWorkers()`
      // call) and bob's session/worker appear in `body.results` and
      // `restartSpy` is called with `sessionB.id` -- see this PR's body for
      // the pasted failing-as-expected output from that manual check.
    } finally {
      (serverConfig as { AUTH_MODE: string }).AUTH_MODE = originalAuthMode;
    }
  });
});
