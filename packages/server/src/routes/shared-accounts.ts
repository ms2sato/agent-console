import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { RegisterSharedAccountRequestSchema } from '@agent-console/shared';
import type { SharedAccountRepository } from '../repositories/shared-account-repository.js';
import { lookupOsUser, type OsUserInfo } from '../services/os-user-lookup.js';
import type { UserRepository } from '../repositories/user-repository.js';
import type { Database } from '../database/schema.js';
import type { SharedAccountRegistry } from '../services/shared-account-registry.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { serverConfig } from '../lib/server-config.js';
import { createLogger } from '../lib/logger.js';
import type { AppBindings } from '../app-context.js';

const logger = createLogger('api:shared-accounts');

/**
 * Core registration logic for `POST /` (operator-initiated, guarded).
 *
 * Upserts/reuses the `users` row for the already-resolved `osInfo`, persists
 * it as a shared account, and updates the live in-memory
 * `SharedAccountRegistry` cache (`register`) so the account is immediately
 * usable for shared-session creation in this process -- no restart needed.
 * Does NOT resolve the OS account and does NOT handle the does-not-resolve
 * case -- the caller already needs its own `lookupOsUser` call for the
 * personal-session guard, so resolution is the caller's responsibility and
 * is never duplicated here. Lets a duplicate registration's
 * unique-constraint error propagate unchanged (the caller decides how to
 * translate it).
 */
async function registerSharedAccountCore(
  username: string,
  osInfo: OsUserInfo,
  createdBy: string | null,
  deps: {
    sharedAccountRepository: SharedAccountRepository;
    userRepository: UserRepository;
    sharedAccountRegistry: SharedAccountRegistry;
  },
): Promise<{ userId: string }> {
  const user = await deps.userRepository.upsertByOsUid(osInfo.uid, username, osInfo.homeDir);
  await deps.sharedAccountRepository.register(user.id, createdBy);
  deps.sharedAccountRegistry.register({ userId: user.id, username: user.username, resolvable: true });

  logger.info({ username, userId: user.id, createdBy }, 'Shared account registered');
  return { userId: user.id };
}

const sharedAccounts = new Hono<AppBindings>()
  // List every registered shared account, with per-account usage counts.
  .get('/', async (c) => {
    if (serverConfig.AUTH_MODE === 'none') {
      throw new ValidationError('Shared accounts are not available in AUTH_MODE=none.');
    }

    const { sharedAccountRepository } = c.get('appContext');
    const rows = await sharedAccountRepository.list();

    const accounts = await Promise.all(
      rows.map(async (row) => ({
        username: row.username,
        registeredAt: row.createdAt,
        boundRepositoryCount: await sharedAccountRepository.countBoundRepositories(row.userId),
        sessionCount: await sharedAccountRepository.countSessions(row.userId),
      })),
    );

    return c.json({ accounts });
  })
  // Register a new shared account.
  .post('/', vValidator(RegisterSharedAccountRequestSchema), async (c) => {
    if (serverConfig.AUTH_MODE === 'none') {
      throw new ValidationError('Shared accounts are not available in AUTH_MODE=none.');
    }

    const { username } = c.req.valid('json');
    const { sharedAccountRepository, userRepository, sharedAccountRegistry, db } = c.get('appContext');
    const authUser = c.get('authUser');

    // Guard 1: refuse registering the caller's own account.
    if (username === authUser.username) {
      throw new ValidationError('Cannot register your own account as a shared account.');
    }

    // Guard 2: refuse an account that already has PERSONAL sessions --
    // sessions with created_by = this account AND initiated_by IS NULL,
    // EXCLUDING the case where this account is already a member of the
    // registry's current set. delegate_to_worktree never sets
    // initiated_by, so an already-registered shared account's own
    // MCP-delegated child sessions would otherwise look "personal" and trip
    // this guard.
    const osInfo = await lookupOsUser(username);
    if (!osInfo) {
      throw new ValidationError(`'${username}' does not resolve to an OS account.`);
    }
    // Resolve (without creating) whether this OS account already has a
    // `users` row, so the personal-session guard can check its history
    // before `registerSharedAccountCore` upserts it.
    const existingUserId = await resolveExistingUserId(db, osInfo.uid);
    if (existingUserId && !sharedAccountRegistry.isSharedUserId(existingUserId)) {
      const personalSessionCount = await countPersonalSessions(db, existingUserId);
      if (personalSessionCount > 0) {
        throw new ConflictError(
          `'${username}' already has ${personalSessionCount} personal session(s) and cannot be registered as a shared account.`,
        );
      }
    }

    let result: { userId: string };
    try {
      result = await registerSharedAccountCore(username, osInfo, authUser.id, {
        sharedAccountRepository,
        userRepository,
        sharedAccountRegistry,
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(`'${username}' is already registered as a shared account.`);
      }
      throw err;
    }

    return c.json({ username, userId: result.userId }, 201);
  })
  // Unregister a shared account.
  .delete('/:username', async (c) => {
    if (serverConfig.AUTH_MODE === 'none') {
      throw new ValidationError('Shared accounts are not available in AUTH_MODE=none.');
    }

    const username = c.req.param('username');
    const { sharedAccountRepository, sharedAccountRegistry } = c.get('appContext');

    const accounts = await sharedAccountRepository.list();
    const match = accounts.find((a) => a.username === username);
    if (!match) {
      throw new NotFoundError('Shared account');
    }

    const [boundRepositoryCount, sessionCount] = await Promise.all([
      sharedAccountRepository.countBoundRepositories(match.userId),
      sharedAccountRepository.countSessions(match.userId),
    ]);
    if (boundRepositoryCount > 0 || sessionCount > 0) {
      throw new ConflictError(
        `'${username}' is still in use (${boundRepositoryCount} bound repositor${boundRepositoryCount === 1 ? 'y' : 'ies'}, ${sessionCount} session(s)) and cannot be unregistered.`,
      );
    }

    await sharedAccountRepository.unregister(match.userId);
    sharedAccountRegistry.unregister(match.userId);
    return c.json({ success: true });
  });

/**
 * Resolve an existing `users.id` for an OS uid, without creating a row.
 * Used only by `POST /`'s personal-session guard -- it must check history
 * BEFORE `registerSharedAccountCore`'s upsert, which would otherwise create
 * the row first and make "existing" trivially true.
 */
async function resolveExistingUserId(db: Kysely<Database>, osUid: number): Promise<string | null> {
  const row = await db.selectFrom('users').select('id').where('os_uid', '=', osUid).executeTakeFirst();
  return row?.id ?? null;
}

/** Count sessions with `created_by = userId AND initiated_by IS NULL`. */
async function countPersonalSessions(db: Kysely<Database>, userId: string): Promise<number> {
  const result = await db
    .selectFrom('sessions')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('created_by', '=', userId)
    .where('initiated_by', 'is', null)
    .executeTakeFirst();
  return Number(result?.count ?? 0);
}

/** Detects a SQLite unique/primary-key constraint violation. */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/.test(error.message);
}

export { sharedAccounts };
