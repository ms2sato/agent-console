import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { RegisterSharedAccountRequestSchema } from '@agent-console/shared';
import type { SharedAccountRepository } from '../repositories/shared-account-repository.js';
import { lookupOsUser } from '../services/os-user-lookup.js';
import type { UserRepository } from '../repositories/user-repository.js';
import type { Database } from '../database/schema.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { serverConfig } from '../lib/server-config.js';
import { createLogger } from '../lib/logger.js';
import type { AppBindings } from '../app-context.js';

const logger = createLogger('api:shared-accounts');

/**
 * Core registration logic shared by `POST /` (operator-initiated, guarded)
 * and `POST /import-env` (automated import of the env-var shared account,
 * unguarded -- see this module's `POST /import-env` handler for why it
 * skips the two guards `POST /` applies).
 *
 * Resolves `username` against the host OS, upserts/reuses the corresponding
 * `users` row, and registers it as a shared account. Throws `ValidationError`
 * when the username does not resolve to an OS account; lets a duplicate
 * registration's unique-constraint error propagate unchanged (callers decide
 * how to translate it).
 */
async function registerSharedAccountCore(
  username: string,
  createdBy: string | null,
  deps: { sharedAccountRepository: SharedAccountRepository; userRepository: UserRepository },
): Promise<{ userId: string }> {
  const osInfo = await lookupOsUser(username);
  if (!osInfo) {
    throw new ValidationError(`'${username}' does not resolve to an OS account.`);
  }

  const user = await deps.userRepository.upsertByOsUid(osInfo.uid, username, osInfo.homeDir);
  await deps.sharedAccountRepository.register(user.id, createdBy);

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
    const { sharedAccountRepository, userRepository } = c.get('appContext');
    const authUser = c.get('authUser');

    // Guard 1: refuse registering the caller's own account.
    if (username === authUser.username) {
      throw new ValidationError('Cannot register your own account as a shared account.');
    }

    // Guard 2: refuse an account that already has PERSONAL sessions --
    // sessions with created_by = this account AND initiated_by IS NULL,
    // EXCLUDING the case where this account is already a member of the
    // env-var registry's current set. delegate_to_worktree never sets
    // initiated_by, so the env-var shared account's own MCP-delegated child
    // sessions would otherwise look "personal" and trip this guard.
    const { sharedAccountRegistry, db } = c.get('appContext');
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
      result = await registerSharedAccountCore(username, authUser.id, { sharedAccountRepository, userRepository });
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
    const { sharedAccountRepository } = c.get('appContext');

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
    return c.json({ success: true });
  })
  // Import the env-var-configured shared account (AGENT_CONSOLE_SHARED_USERNAME)
  // into the DB-backed registry. Idempotent; skips the operator-facing
  // guards `POST /` applies (self-registration, personal-session check) --
  // the env-var account is operator-vouched for by the unit file that set it.
  .post('/import-env', async (c) => {
    if (serverConfig.AUTH_MODE === 'none') {
      throw new ValidationError('Shared accounts are not available in AUTH_MODE=none.');
    }

    const { sharedAccountRegistry, sharedAccountRepository, userRepository } = c.get('appContext');
    const username = sharedAccountRegistry.getDefaultUsername();
    if (!username) {
      return c.json({ error: 'No env-var shared account is configured' }, 404);
    }

    const accounts = await sharedAccountRepository.list();
    const already = accounts.find((a) => a.username === username);
    if (already) {
      return c.json({ imported: false });
    }

    // Self-registering: there is no operator-initiated caller here, so the
    // env-var account is recorded as having registered itself.
    const defaultUserId = sharedAccountRegistry.getDefaultUserId();
    await registerSharedAccountCore(username, defaultUserId, { sharedAccountRepository, userRepository });

    return c.json({ imported: true });
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
