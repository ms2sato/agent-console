/**
 * Boundary Test: an inbound GitHub webhook for a PAUSED session is deferred
 * into the resume digest (PR-2 of Issue #2204).
 *
 * Exercises the REAL chain:
 *
 *   real signed POST /webhooks/github
 *     -> real GitHubServiceParser (HMAC check) -> real job queue
 *     -> real createInboundEventJobHandler + resolveTargets (paused session
 *        read from the real sessions table through getAllPausedSessions)
 *     -> real AgentWorkerHandler -> real SessionManager.deliverWorkerNotification
 *        -> real deferred_worker_notifications row (kind inbound-event,
 *        source_id = the job id)
 *     -> real POST /api/sessions/:id/resume -> real flush -> ONE digest
 *
 * Recorded proxies (pre-pr-completeness.md Q13): the PTY provider is the mock
 * one (no real agent is spawned), and the agent-worker readiness gate is
 * shortened through the `readiness` test-context override (the gate's cap
 * fires; the byte floor is unreachable with a mock PTY). Single-user mode.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import { api } from '@agent-console/server/src/routes/api';
import { webhooks } from '@agent-console/server/src/routes/webhooks';
import { serverConfig } from '@agent-console/server/src/lib/server-config';
import { CLAUDE_CODE_AGENT_ID } from '@agent-console/server/src/services/agent-manager';

const TEST_REPO_PATH = '/test/repo-inbound-paused';
const WORKTREE_PATH = '/test/repo-inbound-paused-wt';
const BRANCH = 'feature-branch';
const SECRET = 'inbound-paused-secret';

async function waitFor<T>(read: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Boundary: inbound webhook to a paused session is deferred into the resume digest', () => {
  const originalSecret = serverConfig.GITHUB_WEBHOOK_SECRET;
  let ctx: AppContext;
  let app: Hono<AppBindings>;
  let ptyFactory: ReturnType<typeof createMockPtyFactory>;
  let sessionId: string;

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      [`${WORKTREE_PATH}/.keep`]: '',
    });
    // The parser reads the secret when the context builds it.
    (serverConfig as { GITHUB_WEBHOOK_SECRET: string }).GITHUB_WEBHOOK_SECRET = SECRET;

    ptyFactory = createMockPtyFactory();
    ctx = await createTestContext({
      ptyProvider: ptyFactory.provider,
      readiness: { minOutputBytes: 1_000_000, settleMs: 5, capMs: 50 },
    });
    const repo = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH);
    const session = await ctx.sessionManager.createSession({
      type: 'worktree',
      locationPath: WORKTREE_PATH,
      repositoryId: repo.id,
      worktreeId: BRANCH,
      agentId: CLAUDE_CODE_AGENT_ID,
    });
    sessionId = session.id;

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', ctx);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
    app.route('/webhooks', webhooks);
  });

  afterEach(async () => {
    (serverConfig as { GITHUB_WEBHOOK_SECRET: string }).GITHUB_WEBHOOK_SECRET = originalSecret;
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function postSignedCiCompleted(): Promise<void> {
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: { conclusion: 'success', name: 'CI', html_url: 'https://example.com/run/1', head_branch: BRANCH },
      repository: { full_name: 'owner/repo' },
    });
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': signature, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
  }

  it('defers the event while paused (one row, source_id = job id, zero PTY writes, ledger delivered), then delivers it in ONE digest on resume', async () => {
    const pauseRes = await app.request(`/api/sessions/${sessionId}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(200);
    expect(ctx.sessionManager.getSession(sessionId)).toBeUndefined();
    const writesAfterPause = ptyFactory.instances.map((p) => p.writtenData.length);

    await postSignedCiCompleted();

    const ledger = await waitFor(async () => {
      const rows = await ctx.db
        .selectFrom('inbound_event_notifications')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('handler_id', '=', 'agent-worker')
        .execute();
      return rows.length > 0 && rows[0].status !== 'pending' ? rows : null;
    }, 'the agent-worker ledger row to settle');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('delivered');

    const deferred = await ctx.db.selectFrom('deferred_worker_notifications').selectAll().execute();
    expect(deferred).toHaveLength(1);
    expect(deferred[0].session_id).toBe(sessionId);
    expect(deferred[0].kind).toBe('inbound-event');
    expect(deferred[0].source_id).toBe(ledger[0].job_id);
    expect(ptyFactory.instances.map((p) => p.writtenData.length)).toEqual(writesAfterPause);

    const resumeRes = await app.request(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
    expect(resumeRes.status).toBe(200);

    const digestWrites = await waitFor(() => {
      const all = ptyFactory.instances.flatMap((p) => p.writtenData);
      const found = all.filter((w) => w.includes('[internal:paused-digest]'));
      return found.length > 0 ? found : null;
    }, 'the resume digest PTY write');
    expect(digestWrites).toHaveLength(1);
    expect(digestWrites[0]).toContain('count=1');
    expect(digestWrites[0]).toContain('[inbound:ci:completed]');

    expect(await ctx.db.selectFrom('deferred_worker_notifications').selectAll().execute()).toHaveLength(0);
  });

  it('one malformed paused row does not block routing: the live session and the other paused session are still targeted', async () => {
    const repo = (await ctx.repositoryManager.getAllRepositories())[0];
    const paused = await ctx.sessionManager.createSession({
      type: 'worktree',
      locationPath: WORKTREE_PATH,
      repositoryId: repo.id,
      worktreeId: BRANCH,
      agentId: CLAUDE_CODE_AGENT_ID,
    });
    const malformed = await ctx.sessionManager.createSession({
      type: 'worktree',
      locationPath: WORKTREE_PATH,
      repositoryId: repo.id,
      worktreeId: 'malformed-branch',
      agentId: CLAUDE_CODE_AGENT_ID,
    });
    expect((await app.request(`/api/sessions/${paused.id}/pause`, { method: 'POST' })).status).toBe(200);
    expect((await app.request(`/api/sessions/${malformed.id}/pause`, { method: 'POST' })).status).toBe(200);

    // Corrupt only the malformed row as read from persistence: an unknown
    // worker type makes persistedToPublicSession throw for that row alone.
    const sessionRepo = ctx.sessionManager.getSessionRepository();
    const realRows = await sessionRepo.findPaused();
    expect(realRows.map((r) => r.id).sort()).toEqual([paused.id, malformed.id].sort());
    const corrupted = realRows.map((row) =>
      row.id === malformed.id
        ? { ...row, workers: [{ id: 'bad-worker', type: 'bogus-type', name: 'x', createdAt: '2024-01-01T00:00:00.000Z' }] }
        : row
    ) as typeof realRows;
    const findPausedSpy = spyOn(sessionRepo, 'findPaused').mockResolvedValue(corrupted);
    try {
      await postSignedCiCompleted();

      const ledger = await waitFor(async () => {
        const rows = await ctx.db
          .selectFrom('inbound_event_notifications')
          .selectAll()
          .where('handler_id', '=', 'agent-worker')
          .execute();
        const settled = rows.filter((r) => r.status !== 'pending');
        return settled.length >= 2 ? settled : null;
      }, 'the live and the paused ledger rows to settle');
      expect(ledger.map((r) => r.session_id).sort()).toEqual([sessionId, paused.id].sort());
      expect(ledger.every((r) => r.status === 'delivered')).toBe(true);

      const deferred = await ctx.db.selectFrom('deferred_worker_notifications').selectAll().execute();
      expect(deferred.map((r) => r.session_id)).toEqual([paused.id]);
    } finally {
      findPausedSpy.mockRestore();
    }
  });
});
