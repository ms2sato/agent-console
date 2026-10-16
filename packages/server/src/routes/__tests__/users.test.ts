/**
 * Sibling test for the member directory route: real in-memory sqlite DB,
 * production layering (appContext -> authMiddleware -> route).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import * as v from 'valibot';
import type { AuthUser } from '@agent-console/shared';
import { UsersListResponseSchema } from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { users } from '../users.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';

const CALLER: AuthUser = { id: 'caller-1', username: 'caller', homeDir: '/home/caller' };

function mockUserMode(user: AuthUser | null): UserMode {
  return {
    authenticate: () => user,
    login: async () => null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

function buildApp(userRepository: SqliteUserRepository, caller: AuthUser | null): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = { userRepository, userMode: mockUserMode(caller) };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.use('*', authMiddleware);
  app.onError(onApiError);
  app.route('/api/users', users);
  return app;
}

describe('User directory route', () => {
  let db: Kysely<Database>;
  let repository: SqliteUserRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteUserRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = await buildApp(repository, null).request('/api/users');
    expect(res.status).toBe(401);
  });

  it('returns an empty list when there are no users', async () => {
    const res = await buildApp(repository, CALLER).request('/api/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: [] });
  });

  it('works with a single user (single-user mode)', async () => {
    const only = await repository.upsertByOsUid(1000, 'solo', '/home/solo');
    const res = await buildApp(repository, only).request('/api/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: [{ id: only.id, username: 'solo' }] });
  });

  it('lists users ordered by username, exposing only id and username', async () => {
    const carol = await repository.upsertByOsUid(1003, 'carol', '/home/carol');
    const alice = await repository.upsertByOsUid(1001, 'alice', '/home/alice');
    const bob = await repository.upsertByOsUid(1002, 'bob', '/home/bob');

    const res = await buildApp(repository, alice).request('/api/users');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      users: [
        { id: alice.id, username: 'alice' },
        { id: bob.id, username: 'bob' },
        { id: carol.id, username: 'carol' },
      ],
    });
    for (const entry of (body as { users: Record<string, unknown>[] }).users) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'username']);
    }
    expect(v.safeParse(UsersListResponseSchema, body).success).toBe(true);
  });
});
