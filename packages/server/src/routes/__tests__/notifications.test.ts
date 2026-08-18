/**
 * Sibling test for the notification center routes (Notification Center
 * Phase 1, Issue #1353, S5).
 *
 * Built on real `SqliteArtifactRepository` +
 * `SqliteNotificationCursorRepository` (real in-memory sqlite db), wired
 * into a hand-built Hono app -- mirrors `routes/__tests__/artifacts.test.ts`'s
 * `buildApp` pattern so auth can be controlled precisely via `mockUserMode`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { Kysely } from 'kysely';
import type { AuthUser } from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { SqliteNotificationCursorRepository } from '../../repositories/sqlite-notification-cursor-repository.js';
import { NotificationService } from '../../services/notification-service.js';
import { notifications } from '../notifications.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';

const OWNER: AuthUser = { id: 'owner-1', username: 'owner', homeDir: '/home/owner' };

function mockUserMode(authenticateResult: AuthUser | null): UserMode {
  return {
    authenticate: () => authenticateResult,
    login: async () => null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

function buildApp(
  artifactRepository: SqliteArtifactRepository,
  notificationCursorRepository: SqliteNotificationCursorRepository,
  authenticateResult: AuthUser | null,
): Hono<AppBindings> {
  const notificationService = new NotificationService({
    artifactRepository,
    jobs: { getJobs: async () => [] },
    cursorRepository: notificationCursorRepository,
  });
  const partialContext: Partial<AppContext> = {
    artifactRepository,
    notificationCursorRepository,
    notificationService,
    userMode: mockUserMode(authenticateResult),
  };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.use('*', authMiddleware);
  app.onError(onApiError);
  app.route('/api/notifications', notifications);
  return app;
}

describe('Notification routes', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  let db: Kysely<Database>;
  let artifactRepository: SqliteArtifactRepository;
  let notificationCursorRepository: SqliteNotificationCursorRepository;

  beforeEach(async () => {
    // artifactRepository.create writes a real on-disk HTML file
    // (lib/artifact-storage.ts, Bun-native, bypasses memfs) -- point
    // AGENT_CONSOLE_HOME at a throwaway temp dir, same as
    // routes/__tests__/artifacts.test.ts.
    process.env.AGENT_CONSOLE_HOME = path.join(os.tmpdir(), `agent-console-notification-routes-test-${randomUUID()}`);
    db = await createDatabaseForTest();
    artifactRepository = new SqliteArtifactRepository(db);
    notificationCursorRepository = new SqliteNotificationCursorRepository(db);

    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({ id: OWNER.id, os_uid: null, username: OWNER.username, home_dir: OWNER.homeDir, created_at: now, updated_at: now })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  describe('GET /api/notifications', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const app = buildApp(artifactRepository, notificationCursorRepository, null);
      const res = await app.request('/api/notifications');
      expect(res.status).toBe(401);
    });

    it('returns an empty feed for an authenticated user with no notifications', async () => {
      const app = buildApp(artifactRepository, notificationCursorRepository, OWNER);
      const res = await app.request('/api/notifications');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; lastSeenAt: string | null; unreadCount: number };
      expect(body).toEqual({ items: [], lastSeenAt: null, unreadCount: 0 });
    });

    it('includes a real seeded artifact with the right shape', async () => {
      const created = await artifactRepository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'My Dashboard',
        content: '<p>hi</p>',
        sourceSessionId: null,
      });

      const app = buildApp(artifactRepository, notificationCursorRepository, OWNER);
      const res = await app.request('/api/notifications');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { kind: string; id: string; title: string; link: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        kind: 'artifact-created',
        id: created.id,
        title: 'My Dashboard',
        link: `/artifacts/${created.id}`,
      });
    });
  });

  describe('PUT /api/notifications/seen', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const app = buildApp(artifactRepository, notificationCursorRepository, null);
      const res = await app.request('/api/notifications/seen', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSeenAt: new Date().toISOString() }),
      });
      expect(res.status).toBe(401);
    });

    it('advances the cursor, readable via a subsequent GET', async () => {
      const app = buildApp(artifactRepository, notificationCursorRepository, OWNER);
      const seenAt = '2026-08-18T00:00:00.000Z';
      const res = await app.request('/api/notifications/seen', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSeenAt: seenAt }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lastSeenAt: string };
      expect(body.lastSeenAt).toBe(seenAt);

      const getRes = await app.request('/api/notifications');
      const getBody = (await getRes.json()) as { lastSeenAt: string | null };
      expect(getBody.lastSeenAt).toBe(seenAt);
    });

    it('rejects a malformed (non-ISO) lastSeenAt with 400 (R4.8)', async () => {
      const app = buildApp(artifactRepository, notificationCursorRepository, OWNER);
      const res = await app.request('/api/notifications/seen', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSeenAt: 'not-a-timestamp' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a lastSeenAt far in the future with 400', async () => {
      const app = buildApp(artifactRepository, notificationCursorRepository, OWNER);
      const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await app.request('/api/notifications/seen', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSeenAt: farFuture }),
      });
      expect(res.status).toBe(400);
    });

    it('is a no-op (200, unchanged cursor) when lastSeenAt is OLDER than the current cursor (R2)', async () => {
      const app = buildApp(artifactRepository, notificationCursorRepository, OWNER);
      const newer = '2026-08-18T02:00:00.000Z';
      const older = '2026-08-18T01:00:00.000Z';

      await app.request('/api/notifications/seen', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSeenAt: newer }),
      });

      const res = await app.request('/api/notifications/seen', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastSeenAt: older }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lastSeenAt: string };
      expect(body.lastSeenAt).toBe(newer);
    });
  });
});
