/**
 * Sibling test for the shared-account routes (shared-accounts design,
 * Release 1: storage only -- not consulted by session creation).
 *
 * Uses a real in-memory sqlite DB (`createDatabaseForTest`) plus the real
 * `lookupOsUser` OS-lookup helper against the CURRENT PROCESS'S OWN OS
 * account (guaranteed to exist, unlike a synthetic username) for the
 * "resolves" paths, and an implausible username for the "does not resolve"
 * path. This avoids `mock.module()`-ing `os-user-lookup.js`, which is
 * imported for real by several other production modules (see
 * `.claude/rules/testing.md` Anti-Pattern #2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'os';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { AuthUser } from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteSharedAccountRepository } from '../../repositories/sqlite-shared-account-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SharedAccountRegistry } from '../../services/shared-account-registry.js';
import { sharedAccounts } from '../shared-accounts.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import { serverConfig } from '../../lib/server-config.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';

const CALLER: AuthUser = { id: 'caller-1', username: 'caller', homeDir: '/home/caller' };
const REAL_OS_USERNAME = os.userInfo().username;
const REAL_OS_UID = os.userInfo().uid;
const NONEXISTENT_USERNAME = 'this-user-almost-certainly-does-not-exist-shared-accounts-test';

function mockUserMode(authenticateResult: AuthUser | null): UserMode {
  return {
    authenticate: () => authenticateResult,
    login: async () => null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

function buildApp(partial: Partial<AppContext>, authenticateResult: AuthUser | null = CALLER): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = {
    userMode: mockUserMode(authenticateResult),
    sharedAccountRegistry: SharedAccountRegistry.createDisabled(),
    ...partial,
  };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.use('*', authMiddleware);
  app.onError(onApiError);
  app.route('/api/shared-accounts', sharedAccounts);
  return app;
}

describe('Shared account routes', () => {
  let db: Kysely<Database>;
  let sharedAccountRepository: SqliteSharedAccountRepository;
  let userRepository: SqliteUserRepository;
  let originalAuthMode: string;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    sharedAccountRepository = new SqliteSharedAccountRepository(db);
    userRepository = new SqliteUserRepository(db);
    originalAuthMode = serverConfig.AUTH_MODE;
    (serverConfig as { AUTH_MODE: string }).AUTH_MODE = 'multi-user';

    // `shared_accounts.created_by` carries a real FK to `users.id` -- seed a
    // row for the authenticated caller so `register(userId, authUser.id)`
    // does not hit a foreign-key-constraint error.
    await db
      .insertInto('users')
      .values({
        id: CALLER.id,
        os_uid: null,
        username: CALLER.username,
        home_dir: CALLER.homeDir,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
  });

  afterEach(async () => {
    (serverConfig as { AUTH_MODE: string }).AUTH_MODE = originalAuthMode;
    await db.destroy();
  });

  // =========================================================================
  // AUTH_MODE=none: all four endpoints are unavailable
  // =========================================================================

  describe('AUTH_MODE=none', () => {
    beforeEach(() => {
      (serverConfig as { AUTH_MODE: string }).AUTH_MODE = 'none';
    });

    it('GET / returns 400', async () => {
      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts');
      expect(res.status).toBe(400);
    });

    it('POST / returns 400', async () => {
      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: REAL_OS_USERNAME }),
      });
      expect(res.status).toBe(400);
    });

    it('DELETE /:username returns 400', async () => {
      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts/anyone', { method: 'DELETE' });
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /api/shared-accounts/import-env -- the route no longer exists
  // (Release 2: the env var is no longer a session-creation or
  // registration source -- see app-context.ts's `resolveSharedAccountEnvVarWarnings`
  // and docs/design/shared-orchestrator-session.md). A request to this path
  // falls through to Hono's default unmatched-route 404, in EVERY AUTH_MODE
  // (not an AUTH_MODE=none-specific 400 as Release 1 returned).
  // =========================================================================

  it('POST /import-env: route no longer exists, falls through to Hono\'s default 404 (multi-user mode)', async () => {
    const app = buildApp({ sharedAccountRepository, userRepository });
    const res = await app.request('/api/shared-accounts/import-env', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  // =========================================================================
  // GET /api/shared-accounts
  // =========================================================================

  describe('GET /api/shared-accounts', () => {
    it('returns an empty list when nothing is registered', async () => {
      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accounts: unknown[] };
      expect(body.accounts).toEqual([]);
    });

    it('lists a registered account with usage counts; resolvable: false when the live registry has no matching (or no) entry', async () => {
      const shared = await userRepository.upsertByOsUid(70001, 'shared-bot', '/home/shared-bot');
      await sharedAccountRepository.register(shared.id, CALLER.id);

      // Default buildApp registry is createDisabled() (no entries), so
      // getEntry(shared.id) is undefined -> falls back to resolvable: false.
      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts');
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        accounts: Array<{ username: string; registeredAt: string; boundRepositoryCount: number; sessionCount: number; resolvable: boolean }>;
      };
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0]).toMatchObject({
        username: 'shared-bot',
        boundRepositoryCount: 0,
        sessionCount: 0,
        resolvable: false,
      });
      expect(typeof body.accounts[0]?.registeredAt).toBe('string');
    });

    it('reports resolvable: true when the live registry has a matching, resolvable entry', async () => {
      const shared = await userRepository.upsertByOsUid(70005, 'shared-bot-resolvable', '/home/shared-bot-resolvable');
      await sharedAccountRepository.register(shared.id, CALLER.id);

      const sharedAccountRegistry = SharedAccountRegistry.createDisabled();
      sharedAccountRegistry.register({ userId: shared.id, username: 'shared-bot-resolvable', resolvable: true });

      const app = buildApp({ sharedAccountRepository, userRepository, sharedAccountRegistry });
      const res = await app.request('/api/shared-accounts');
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        accounts: Array<{ username: string; resolvable: boolean }>;
      };
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0]?.resolvable).toBe(true);
    });
  });

  // =========================================================================
  // POST /api/shared-accounts
  // =========================================================================

  describe('POST /api/shared-accounts', () => {
    it('registers a resolvable OS account', async () => {
      const app = buildApp({ sharedAccountRepository, userRepository, db } as Partial<AppContext>);
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: REAL_OS_USERNAME }),
      });
      expect(res.status).toBe(201);

      const accounts = await sharedAccountRepository.list();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.username).toBe(REAL_OS_USERNAME);
      expect(accounts[0]?.createdBy).toBe(CALLER.id);
    });

    it('rejects registering your own account (400)', async () => {
      const selfCaller: AuthUser = { id: 'self-1', username: REAL_OS_USERNAME, homeDir: '/home/self' };
      const app = buildApp({ sharedAccountRepository, userRepository, db } as Partial<AppContext>, selfCaller);
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: REAL_OS_USERNAME }),
      });
      expect(res.status).toBe(400);
      expect(await sharedAccountRepository.list()).toEqual([]);
    });

    it('rejects a username that does not resolve to an OS account (400)', async () => {
      const app = buildApp({ sharedAccountRepository, userRepository, db } as Partial<AppContext>);
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: NONEXISTENT_USERNAME }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an account that already has personal sessions (409)', async () => {
      const existing = await userRepository.upsertByOsUid(REAL_OS_UID, REAL_OS_USERNAME, '/home/real');
      await db
        .insertInto('sessions')
        .values({
          id: 'session-personal',
          type: 'quick',
          location_path: '/tmp/personal',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          server_pid: null,
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
          created_by: existing.id,
          initiated_by: null,
        })
        .execute();

      const app = buildApp({ sharedAccountRepository, userRepository, db } as Partial<AppContext>);
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: REAL_OS_USERNAME }),
      });
      expect(res.status).toBe(409);
      expect(await sharedAccountRepository.list()).toEqual([]);
    });

    it('allows registering when already a member of the env-var registry set, even with initiated_by-null sessions (guard carve-out)', async () => {
      const existing = await userRepository.upsertByOsUid(REAL_OS_UID, REAL_OS_USERNAME, '/home/real');
      await db
        .insertInto('sessions')
        .values({
          id: 'session-delegated',
          type: 'quick',
          location_path: '/tmp/delegated',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          server_pid: null,
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
          created_by: existing.id,
          initiated_by: null,
        })
        .execute();

      // Build a registry recognizing `existing` as an already-registered
      // shared account (same real OS username, so upsertByOsUid's refresh
      // resolves to the SAME users row via the os_uid conflict key).
      const sharedAccountRegistry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: {
          list: async () => [{ userId: existing.id, username: REAL_OS_USERNAME, createdAt: new Date().toISOString(), createdBy: null }],
          register: async () => {},
          unregister: async () => true,
          countBoundRepositories: async () => 0,
          countSessions: async () => 0,
        },
        userRepository,
      });
      expect(sharedAccountRegistry.isSharedUserId(existing.id)).toBe(true);

      const app = buildApp({ sharedAccountRepository, userRepository, db, sharedAccountRegistry } as Partial<AppContext>);
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: REAL_OS_USERNAME }),
      });
      expect(res.status).toBe(201);
    });

    it('rejects a duplicate registration (409)', async () => {
      const existing = await userRepository.upsertByOsUid(REAL_OS_UID, REAL_OS_USERNAME, '/home/real');
      await sharedAccountRepository.register(existing.id, null);

      const app = buildApp({ sharedAccountRepository, userRepository, db } as Partial<AppContext>);
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: REAL_OS_USERNAME }),
      });
      expect(res.status).toBe(409);
    });
  });

  // =========================================================================
  // DELETE /api/shared-accounts/:username
  // =========================================================================

  describe('DELETE /api/shared-accounts/:username', () => {
    it('unregisters an unused account', async () => {
      const shared = await userRepository.upsertByOsUid(70002, 'shared-bot-2', '/home/shared-bot-2');
      await sharedAccountRepository.register(shared.id, null);

      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts/shared-bot-2', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await sharedAccountRepository.list()).toEqual([]);
    });

    it('returns 404 for an unregistered username', async () => {
      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts/nobody', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('returns 409 when the account is bound to a repository', async () => {
      const shared = await userRepository.upsertByOsUid(70003, 'shared-bot-3', '/home/shared-bot-3');
      await sharedAccountRepository.register(shared.id, null);
      await db.insertInto('repositories').values({ id: 'repo-1', name: 'repo-1', path: '/tmp/repo-1' }).execute();
      await db
        .updateTable('repositories')
        .set({ shared_account_user_id: shared.id })
        .where('id', '=', 'repo-1')
        .execute();

      const app = buildApp({ sharedAccountRepository, userRepository });
      const res = await app.request('/api/shared-accounts/shared-bot-3', { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(await sharedAccountRepository.list()).toHaveLength(1);
    });

    it('returns 409 when the account has sessions', async () => {
      const shared = await userRepository.upsertByOsUid(70004, 'shared-bot-4', '/home/shared-bot-4');
      await sharedAccountRepository.register(shared.id, null);
      await db
        .insertInto('sessions')
        .values({
          id: 'session-shared',
          type: 'quick',
          location_path: '/tmp/shared',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          server_pid: null,
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
          created_by: shared.id,
        })
        .execute();

      const app = buildApp({ sharedAccountRepository, userRepository, db } as Partial<AppContext>);
      const res = await app.request('/api/shared-accounts/shared-bot-4', { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(await sharedAccountRepository.list()).toHaveLength(1);
    });
  });

});
