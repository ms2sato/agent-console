/**
 * Client-Server Boundary Test: ending a worktree session through
 * DELETE /api/sessions/:id (the "End Session" action).
 *
 * Exercises the real chain the End buttons depend on:
 *   real HTTP DELETE /api/sessions/:id -> real route handler
 *   (packages/server/src/routes/sessions.ts) -> real SessionManager
 *   .forceDeleteSession -> real SessionDeletionService (live session first,
 *   then the persisted row) -> real SQLite rows (memory DB) and memfs files.
 *
 * Why this needs the real chain: a PAUSED session exists only in persistence,
 * and the live-only `deleteSession` answers false for it, so the route used to
 * answer 404 and the sidebar / dashboard could not end it. A mocked
 * SessionManager cannot tell the two lookups apart.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  getTestConfigDir,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { InboundEventNotificationRepository } from '@agent-console/server/src/repositories/inbound-event-notification-repository';

const TEST_REPO_PATH = '/test/repo-end';

describe('Client-Server Boundary: DELETE /api/sessions/:id ends worktree sessions', () => {
  let ctx: AppContext;
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext({
      ptyProvider: createMockPtyProvider(),
      assertSpawnCwdFn: async () => {},
    });
    setupMemfs({
      [`${getTestConfigDir()}/.keep`]: '',
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
    app = await createTestApp(ctx);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  /** A worktree session whose locationPath is the repository path, i.e. the primary worktree. */
  async function createMainWorktreeSession() {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH);
    const session = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH,
        repositoryId: repository.id,
        worktreeId: 'main',
        agentId: 'claude-code-builtin',
      },
      { createdBy: owner.id },
    );
    return { repository, session };
  }

  async function sessionRowCount(sessionId: string): Promise<number> {
    const rows = await ctx.db.selectFrom('sessions').select('id').where('id', '=', sessionId).execute();
    return rows.length;
  }

  it('ends a session on the primary worktree: 200, row gone, worktree directory still on disk', async () => {
    const { session } = await createMainWorktreeSession();
    expect(ctx.sessionManager.getSession(session.id)).toBeDefined();
    expect(await sessionRowCount(session.id)).toBe(1);

    const res = await app.request(`/api/sessions/${session.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(ctx.sessionManager.getSession(session.id)).toBeUndefined();
    expect(await sessionRowCount(session.id)).toBe(0);
    // Ending a session never removes the worktree itself.
    expect(existsSync(`${TEST_REPO_PATH}/.git/HEAD`)).toBe(true);
  });

  it('ends a PAUSED session: 200, row, memo file, designation and inbound rows all gone', async () => {
    const { repository, session } = await createMainWorktreeSession();

    const memoPath = await ctx.sessionManager.writeMemo(session.id, 'remember this');
    expect(existsSync(memoPath)).toBe(true);
    await ctx.repositoryManager.addOrchestratorSession(repository.id, session.id);
    await new InboundEventNotificationRepository(ctx.db).createPendingNotification({
      id: 'notif-end-1',
      job_id: 'job-end-1',
      session_id: session.id,
      worker_id: 'worker-end-1',
      handler_id: 'handler-end-1',
      event_type: 'ci:completed',
      event_summary: 'summary',
      created_at: new Date().toISOString(),
    });

    const pauseRes = await app.request(`/api/sessions/${session.id}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(200);
    // Paused = persisted only.
    expect(ctx.sessionManager.getSession(session.id)).toBeUndefined();
    expect(await sessionRowCount(session.id)).toBe(1);

    const res = await app.request(`/api/sessions/${session.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await sessionRowCount(session.id)).toBe(0);
    expect(existsSync(memoPath)).toBe(false);
    const designations = await ctx.db
      .selectFrom('repository_orchestrator_sessions')
      .select('session_id')
      .where('session_id', '=', session.id)
      .execute();
    expect(designations).toHaveLength(0);
    const inbound = await ctx.db
      .selectFrom('inbound_event_notifications')
      .select('id')
      .where('session_id', '=', session.id)
      .execute();
    expect(inbound).toHaveLength(0);
  });

  it('answers 404 when neither a live nor a persisted session exists', async () => {
    const res = await app.request('/api/sessions/does-not-exist', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('pins current behaviour: a tick for a paused session worker is not delivered (live-only lookup) and the timer survives', async () => {
    const { session } = await createMainWorktreeSession();
    const workerId = session.workers[0].id;
    const timer = ctx.timerManager.createTimer({
      sessionId: session.id,
      workerId,
      intervalSeconds: 3600,
      action: 'check',
    });

    const pauseRes = await app.request(`/api/sessions/${session.id}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(200);

    const result = await ctx.sessionManager.deliverWorkerNotification(session.id, workerId, {
      kind: 'internal-timer',
      tag: 'internal:timer',
      fields: { timerId: timer.id, action: 'check', fireCount: '1', nextIntervalSeconds: '3600', nextFireAt: '' },
      intent: 'inform',
    });

    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
    expect(ctx.timerManager.getTimer(timer.id)).toBeDefined();
  });
});
