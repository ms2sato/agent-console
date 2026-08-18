/**
 * Client-Server Boundary Test: GET /api/notifications + PUT
 * /api/notifications/seen (Notification Center Phase 1, Issue #1353).
 *
 * Phase 1 is server-only -- there is no client fetch function yet (Phase 2),
 * so this boundary test issues real HTTP requests against a real Hono app
 * via `app.request(...)` (rather than `artifact-list-boundary.test.ts`'s
 * pattern of driving a client fetch function) and parses the raw JSON with
 * the SAME valibot schemas a future client fetch function will use
 * (`NotificationsResponseSchema` / `NotificationsSeenResponseSchema`).
 *
 * This is the test that would fail if `schemas/notification-item.ts`
 * silently dropped a field relative to `types/notification-item.ts` (the
 * core `.claude/rules/pre-pr-completeness.md` Q10 guard).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { Hono } from 'hono';
import * as v from 'valibot';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
  TEST_AUTH_USER,
} from '@agent-console/server/src/__tests__/test-utils';
import type { AppBindings } from '@agent-console/server/src/app-context';
import { getDatabase } from '@agent-console/server/src/database/connection';
import { SqliteArtifactRepository } from '@agent-console/server/src/repositories/sqlite-artifact-repository';
import { SqliteNotificationCursorRepository } from '@agent-console/server/src/repositories/sqlite-notification-cursor-repository';
import { NotificationService } from '@agent-console/server/src/services/notification-service';

import { NotificationsResponseSchema, NotificationsSeenResponseSchema } from '@agent-console/shared';

describe('Client-Server Boundary: /api/notifications', () => {
  let app: Hono<AppBindings>;
  let artifactRepository: SqliteArtifactRepository;
  let notificationCursorRepository: SqliteNotificationCursorRepository;
  let testHome: string;
  const originalHome = process.env.AGENT_CONSOLE_HOME;

  beforeEach(async () => {
    await setupTestEnvironment();

    // `SqliteArtifactRepository.create` writes the HTML file via
    // `lib/artifact-storage.ts`'s Bun-native `Bun.write` (bypasses
    // `setupTestEnvironment`'s memfs mock -- see that file's own header
    // comment). Same convention as `artifact-list-boundary.test.ts`.
    testHome = path.join(os.tmpdir(), `agent-console-notification-boundary-${randomUUID()}`);
    process.env.AGENT_CONSOLE_HOME = testHome;

    artifactRepository = new SqliteArtifactRepository(getDatabase());
    notificationCursorRepository = new SqliteNotificationCursorRepository(getDatabase());
    const notificationService = new NotificationService({
      artifactRepository,
      jobs: { getJobs: async () => [] },
      cursorRepository: notificationCursorRepository,
    });

    app = await createTestApp({
      artifactRepository,
      notificationCursorRepository,
      notificationService,
    });
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
    Bun.spawnSync(['rm', '-rf', testHome]);
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  it('GET survives the server -> JSON wire -> NotificationsResponseSchema parse round-trip, with a real artifact intact', async () => {
    const created = await artifactRepository.create({
      id: randomUUID(),
      userId: TEST_AUTH_USER.id,
      title: 'My dashboard',
      content: '<p>dashboard</p>',
      sourceSessionId: null,
    });

    const res = await app.request('/api/notifications');
    expect(res.status).toBe(200);
    const rawBody: unknown = await res.json();

    // The crucial assertion: if NotificationsResponseSchema (or
    // NotificationItemSchema) silently drops/renames a field relative to
    // the server's actual response shape, this parse throws.
    const parsed = v.parse(NotificationsResponseSchema, rawBody);

    expect(parsed.items).toHaveLength(1);
    const item = parsed.items[0];
    expect(item.kind).toBe('artifact-created');
    expect(item.id).toBe(created.id);
    expect(item.title).toBe('My dashboard');
    expect(item.link).toBe(`/artifacts/${created.id}`);
    expect(typeof item.occurredAt).toBe('string');

    expect(parsed.lastSeenAt).toBeNull();
    expect(parsed.unreadCount).toBe(1);
  });

  it('GET returns an empty feed (boundary value) with unreadCount 0 and lastSeenAt null when the caller has no notifications', async () => {
    const res = await app.request('/api/notifications');
    expect(res.status).toBe(200);
    const parsed = v.parse(NotificationsResponseSchema, await res.json());
    expect(parsed).toEqual({ items: [], lastSeenAt: null, unreadCount: 0 });
  });

  it('PUT /seen survives the server -> JSON wire -> NotificationsSeenResponseSchema parse round-trip', async () => {
    const seenAt = '2026-08-18T00:00:00.000Z';
    const res = await app.request('/api/notifications/seen', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastSeenAt: seenAt }),
    });
    expect(res.status).toBe(200);
    const parsed = v.parse(NotificationsSeenResponseSchema, await res.json());
    expect(parsed.lastSeenAt).toBe(seenAt);

    // Read-back through GET confirms the cursor was actually persisted, not
    // just echoed back in the PUT response.
    const getRes = await app.request('/api/notifications');
    const getParsed = v.parse(NotificationsResponseSchema, await getRes.json());
    expect(getParsed.lastSeenAt).toBe(seenAt);
  });
});
