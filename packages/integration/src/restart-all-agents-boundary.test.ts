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
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { CLAUDE_SDK_AGENT_ID } from '@agent-console/server/src/services/embedded-agent-manager';

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
    ctx = await createTestContext();
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
});
