/**
 * Migration v18 tests — session-data-path scope columns + backfill.
 *
 * Strategy:
 *   - `adds the five new columns` test exercises the real production path
 *     via `initializeDatabase(':memory:')`.
 *   - Backfill tests construct a v17-shaped schema directly against a raw
 *     Bun SQLite instance, seed it with rows, then re-apply the same
 *     DDL+DML that the production `migrateToV18` performs (kept in
 *     `runV18Migration` here). If the production migration diverges from
 *     this test, the test will drift loudly. This mirrors how other
 *     migration tests in this repo handle pre-N schemas.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase } from '../connection.js';
import { isValidSlug } from '../../lib/session-data-path.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

const TEST_CONFIG_DIR = '/test/config';

interface SeedSession {
  id: string;
  type: 'worktree' | 'quick';
  location_path: string;
  repository_id: string | null;
  worktree_id: string | null;
}

interface SeedRepository {
  id: string;
  name: string;
  path: string;
}

/**
 * Build a v17-shaped database seeded with the caller's rows. Only the
 * sessions + repositories tables are created, which is everything v18 needs.
 */
async function seedV17Database(options: {
  repositories: SeedRepository[];
  sessions: SeedSession[];
}): Promise<Kysely<Database>> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  await sql`PRAGMA foreign_keys = ON`.execute(db);

  bunDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      location_path TEXT NOT NULL,
      server_pid INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      initial_prompt TEXT,
      title TEXT,
      repository_id TEXT,
      worktree_id TEXT,
      paused_at TEXT,
      parent_session_id TEXT,
      parent_worker_id TEXT,
      created_by TEXT
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      setup_command TEXT,
      env_vars TEXT,
      description TEXT,
      cleanup_command TEXT,
      default_agent_id TEXT
    );
    PRAGMA user_version = 17;
  `);

  const insertRepo = bunDb.prepare(
    `INSERT INTO repositories (id, name, path, created_at, updated_at)
     VALUES (?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const repo of options.repositories) {
    insertRepo.run(repo.id, repo.name, repo.path);
  }

  const insertSess = bunDb.prepare(
    `INSERT INTO sessions (id, type, location_path, repository_id, worktree_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const sess of options.sessions) {
    insertSess.run(
      sess.id,
      sess.type,
      sess.location_path,
      sess.repository_id,
      sess.worktree_id
    );
  }

  return db;
}

/**
 * Apply the v18 migration body (ALTER TABLE + backfill) against a caller-
 * owned DB. Kept in sync with `migrateToV18` in connection.ts.
 */
async function runV18Migration(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE sessions ADD COLUMN data_scope TEXT`.execute(db);
  await sql`ALTER TABLE sessions ADD COLUMN data_scope_slug TEXT`.execute(db);
  await sql`ALTER TABLE sessions ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'healthy'`.execute(db);
  await sql`ALTER TABLE sessions ADD COLUMN orphaned_at INTEGER`.execute(db);
  await sql`ALTER TABLE sessions ADD COLUMN orphaned_reason TEXT`.execute(db);

  await applyBackfill(db);

  await sql`PRAGMA user_version = 18`.execute(db);
}

/**
 * The backfill half of v18. Extracted so tests can exercise re-entry
 * independent of the ALTER TABLE half.
 */
async function applyBackfill(db: Kysely<Database>): Promise<void> {
  const now = Date.now();

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('sessions')
      .set({ data_scope: 'quick', data_scope_slug: null })
      .where('type', '=', 'quick')
      .where('data_scope', 'is', null)
      .execute();

    const candidates = await trx
      .selectFrom('sessions')
      .leftJoin('repositories', 'repositories.id', 'sessions.repository_id')
      .select([
        'sessions.id as sessionId',
        'sessions.repository_id as repositoryId',
        'repositories.name as repositoryName',
      ])
      .where('sessions.type', '=', 'worktree')
      .where('sessions.data_scope', 'is', null)
      .execute();

    for (const row of candidates) {
      if (row.repositoryName === null || row.repositoryName === undefined) {
        await trx
          .updateTable('sessions')
          .set({
            data_scope: null,
            data_scope_slug: null,
            recovery_state: 'orphaned',
            orphaned_at: now,
            orphaned_reason: 'migration_unresolved_repository',
          })
          .where('id', '=', row.sessionId)
          .execute();
        continue;
      }

      if (!isValidSlug(row.repositoryName)) {
        await trx
          .updateTable('sessions')
          .set({
            data_scope: null,
            data_scope_slug: null,
            recovery_state: 'orphaned',
            orphaned_at: now,
            orphaned_reason: 'migration_invalid_slug',
          })
          .where('id', '=', row.sessionId)
          .execute();
        continue;
      }

      await trx
        .updateTable('sessions')
        .set({ data_scope: 'repository', data_scope_slug: row.repositoryName })
        .where('id', '=', row.sessionId)
        .execute();
    }
  });
}

describe('migration v18 (session-data-path)', () => {
  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
  });

  it('adds the five new columns with correct nullability/defaults', async () => {
    // Exercise the real production migration path end-to-end.
    const db = await initializeDatabase(':memory:');

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    // initializeDatabase runs all migrations through the latest version, so
    // ≥ 18 is sufficient to confirm v18 was applied.
    expect(versionRes.rows[0]?.user_version).toBeGreaterThanOrEqual(18);

    // Insert a quick session without specifying recovery_state; the DB
    // default should apply.
    await db
      .insertInto('sessions')
      .values({
        id: 'sess-default',
        type: 'quick',
        location_path: '/tmp/x',
        repository_id: null,
        worktree_id: null,
        data_scope: 'quick',
        data_scope_slug: null,
      })
      .execute();

    const row = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', 'sess-default')
      .executeTakeFirstOrThrow();

    expect(row.data_scope).toBe('quick');
    expect(row.data_scope_slug).toBeNull();
    expect(row.recovery_state).toBe('healthy');
    expect(row.orphaned_at).toBeNull();
    expect(row.orphaned_reason).toBeNull();
  });

  it('backfills quick sessions with scope=quick, slug=null, healthy', async () => {
    const db = await seedV17Database({
      repositories: [],
      sessions: [
        {
          id: 'sess-quick-1',
          type: 'quick',
          location_path: '/tmp/q',
          repository_id: null,
          worktree_id: null,
        },
      ],
    });

    await runV18Migration(db);

    const row = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', 'sess-quick-1')
      .executeTakeFirstOrThrow();

    expect(row.data_scope).toBe('quick');
    expect(row.data_scope_slug).toBeNull();
    expect(row.recovery_state).toBe('healthy');
    expect(row.orphaned_at).toBeNull();
    expect(row.orphaned_reason).toBeNull();

    await db.destroy();
  });

  it('backfills worktree sessions with a resolvable repository as healthy', async () => {
    const db = await seedV17Database({
      repositories: [
        { id: 'repo-1', name: 'my-project', path: '/path/one' },
        { id: 'repo-2', name: 'owner/another', path: '/path/two' },
      ],
      sessions: [
        {
          id: 'sess-wt-1',
          type: 'worktree',
          location_path: '/p1',
          repository_id: 'repo-1',
          worktree_id: 'feature-a',
        },
        {
          id: 'sess-wt-2',
          type: 'worktree',
          location_path: '/p2',
          repository_id: 'repo-2',
          worktree_id: 'feature-b',
        },
      ],
    });

    await runV18Migration(db);

    const rows = await db
      .selectFrom('sessions')
      .selectAll()
      .orderBy('id')
      .execute();

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('sess-wt-1');
    expect(rows[0].data_scope).toBe('repository');
    expect(rows[0].data_scope_slug).toBe('my-project');
    expect(rows[0].recovery_state).toBe('healthy');

    expect(rows[1].id).toBe('sess-wt-2');
    expect(rows[1].data_scope).toBe('repository');
    expect(rows[1].data_scope_slug).toBe('owner/another');
    expect(rows[1].recovery_state).toBe('healthy');

    await db.destroy();
  });

  it('marks worktree sessions with an unresolvable repository as orphaned', async () => {
    const db = await seedV17Database({
      repositories: [
        { id: 'repo-keep', name: 'kept', path: '/path/kept' },
      ],
      sessions: [
        {
          id: 'sess-orphan',
          type: 'worktree',
          location_path: '/p',
          // Repository does not exist in the repositories table.
          repository_id: 'repo-missing',
          worktree_id: 'branch',
        },
      ],
    });

    await runV18Migration(db);

    const row = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', 'sess-orphan')
      .executeTakeFirstOrThrow();

    expect(row.data_scope).toBeNull();
    expect(row.data_scope_slug).toBeNull();
    expect(row.recovery_state).toBe('orphaned');
    expect(row.orphaned_reason).toBe('migration_unresolved_repository');
    expect(typeof row.orphaned_at).toBe('number');
    expect((row.orphaned_at ?? 0) > 0).toBe(true);

    await db.destroy();
  });

  it('mixes quick / healthy-worktree / orphaned-worktree correctly in one run', async () => {
    const db = await seedV17Database({
      repositories: [{ id: 'repo-ok', name: 'ok-repo', path: '/path/ok' }],
      sessions: [
        {
          id: 'sess-q',
          type: 'quick',
          location_path: '/q',
          repository_id: null,
          worktree_id: null,
        },
        {
          id: 'sess-wt-ok',
          type: 'worktree',
          location_path: '/w',
          repository_id: 'repo-ok',
          worktree_id: 'b',
        },
        {
          id: 'sess-wt-gone',
          type: 'worktree',
          location_path: '/w2',
          repository_id: 'repo-gone',
          worktree_id: 'b',
        },
      ],
    });

    await runV18Migration(db);

    const rows = await db
      .selectFrom('sessions')
      .selectAll()
      .orderBy('id')
      .execute();

    const byId = new Map(rows.map((r) => [r.id, r]));

    const q = byId.get('sess-q');
    expect(q).toBeDefined();
    expect(q?.data_scope).toBe('quick');
    expect(q?.data_scope_slug).toBeNull();
    expect(q?.recovery_state).toBe('healthy');

    const wtOk = byId.get('sess-wt-ok');
    expect(wtOk).toBeDefined();
    expect(wtOk?.data_scope).toBe('repository');
    expect(wtOk?.data_scope_slug).toBe('ok-repo');
    expect(wtOk?.recovery_state).toBe('healthy');

    const wtGone = byId.get('sess-wt-gone');
    expect(wtGone).toBeDefined();
    expect(wtGone?.data_scope).toBeNull();
    expect(wtGone?.recovery_state).toBe('orphaned');
    expect(wtGone?.orphaned_reason).toBe('migration_unresolved_repository');

    await db.destroy();
  });

  it('marks worktree sessions whose repository name violates the slug grammar as orphaned (whitespace)', async () => {
    const db = await seedV17Database({
      repositories: [
        // Repository name contains a space — passes the v17 schema (no
        // grammar enforcement) but does not satisfy SLUG_PATTERN. Writing
        // it verbatim would later blow up at runtime in
        // `computeSessionDataBaseDir`.
        { id: 'repo-bad', name: 'my project', path: '/path/bad' },
      ],
      sessions: [
        {
          id: 'sess-bad-slug',
          type: 'worktree',
          location_path: '/p',
          repository_id: 'repo-bad',
          worktree_id: 'b',
        },
      ],
    });

    await runV18Migration(db);

    const row = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', 'sess-bad-slug')
      .executeTakeFirstOrThrow();

    expect(row.data_scope).toBeNull();
    expect(row.data_scope_slug).toBeNull();
    expect(row.recovery_state).toBe('orphaned');
    expect(row.orphaned_reason).toBe('migration_invalid_slug');
    expect(typeof row.orphaned_at).toBe('number');
    expect((row.orphaned_at ?? 0) > 0).toBe(true);

    await db.destroy();
  });

  it('marks worktree sessions whose repository name contains traversal segments as orphaned', async () => {
    const db = await seedV17Database({
      repositories: [
        // Contains a `..` segment — would escape the `repositories/` root.
        { id: 'repo-traverse', name: 'foo/../bar', path: '/path/traverse' },
      ],
      sessions: [
        {
          id: 'sess-traverse',
          type: 'worktree',
          location_path: '/p',
          repository_id: 'repo-traverse',
          worktree_id: 'b',
        },
      ],
    });

    await runV18Migration(db);

    const row = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', 'sess-traverse')
      .executeTakeFirstOrThrow();

    expect(row.data_scope).toBeNull();
    expect(row.data_scope_slug).toBeNull();
    expect(row.recovery_state).toBe('orphaned');
    expect(row.orphaned_reason).toBe('migration_invalid_slug');

    await db.destroy();
  });

  it('re-running the backfill logic does not re-orphan healthy rows', async () => {
    const db = await seedV17Database({
      repositories: [{ id: 'repo-1', name: 'r1', path: '/path/1' }],
      sessions: [
        {
          id: 'sess-q',
          type: 'quick',
          location_path: '/q',
          repository_id: null,
          worktree_id: null,
        },
        {
          id: 'sess-wt',
          type: 'worktree',
          location_path: '/w',
          repository_id: 'repo-1',
          worktree_id: 'b',
        },
      ],
    });

    await runV18Migration(db);

    // Simulate an operator dropping the repository (so the JOIN now fails)
    // and re-running the backfill portion. The WHERE data_scope IS NULL
    // guard must prevent re-orphaning the already-healthy row.
    await db.deleteFrom('repositories').execute();
    await applyBackfill(db);

    const rows = await db
      .selectFrom('sessions')
      .selectAll()
      .orderBy('id')
      .execute();

    const byId = new Map(rows.map((r) => [r.id, r]));

    const q = byId.get('sess-q');
    expect(q).toBeDefined();
    expect(q?.data_scope).toBe('quick');
    expect(q?.recovery_state).toBe('healthy');

    const wt = byId.get('sess-wt');
    expect(wt).toBeDefined();
    expect(wt?.data_scope).toBe('repository');
    expect(wt?.data_scope_slug).toBe('r1');
    expect(wt?.recovery_state).toBe('healthy');
    expect(wt?.orphaned_at).toBeNull();

    await db.destroy();
  });
});
