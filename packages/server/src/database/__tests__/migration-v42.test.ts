/**
 * Migration v42 tests — drop the dead `repositories.orchestrator_session_id`
 * column (v40) via a table rebuild (Issue #1725, deferred from #1716's v41
 * migration).
 *
 * Strategy mirrors `migration-v19.test.ts` (the FK-hazard-shape precedent for
 * a table rebuild with real dependent tables) plus `migration-v36.test.ts`
 * (the other DROP-shaped rebuild on this codebase): a raw v41-shaped
 * `repositories` table (with the dead column, its two ISO8601 CHECK
 * constraints, and its three real dependent tables --
 * `repository_orchestrator_sessions`, `worktrees`,
 * `repository_slack_integrations`) is seeded directly against a raw Bun
 * SQLite instance, then the production `migrateToV42` is invoked directly.
 * This exercises the real migration code with no risk of drift between a
 * test-local copy and the production implementation.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import * as fsPromises from 'fs/promises';
import type { Database } from '../schema.js';
import { closeDatabase, initializeDatabase, migrateToV42, backupDatabaseFile } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { expectRebuiltTableDdl } from './helpers/ddl-pin.js';

const TEST_CONFIG_DIR = '/test/config';

interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SeedRepository {
  id: string;
  name: string;
  path: string;
  setup_command: string | null;
  env_vars: string | null;
  description: string | null;
  cleanup_command: string | null;
  default_agent_id: string | null;
  orchestrator_session_id: string | null;
  issue_trigger_labels: string | null;
}

/**
 * Build a v41-shaped database: `repositories` exactly as it existed at v41
 * (dead column still present, with its two ISO8601 CHECK constraints), plus
 * the minimal `agents` / `sessions` tables `default_agent_id` /
 * `orchestrator_session_id` reference, and the three real dependent tables
 * this migration's FK-rewrite-on-rename hazard concerns.
 */
function seedV41Database(options: { repositories: SeedRepository[] }): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec('PRAGMA foreign_keys = ON;');

  bunDb.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command_template TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      location_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      setup_command TEXT,
      env_vars TEXT,
      description TEXT,
      cleanup_command TEXT,
      default_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      orchestrator_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      issue_trigger_labels TEXT,
      CONSTRAINT repositories_created_at_iso8601 CHECK (created_at IS NULL OR created_at GLOB '????-??-??T??:??:??*Z'),
      CONSTRAINT repositories_updated_at_iso8601 CHECK (updated_at IS NULL OR updated_at GLOB '????-??-??T??:??:??*Z')
    );

    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      index_number INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE repository_slack_integrations (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,
      webhook_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE repository_orchestrator_sessions (
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repository_id, session_id)
    );

    PRAGMA user_version = 41;
  `);

  const insertAgent = bunDb.prepare(`INSERT INTO agents (id, name, command_template) VALUES (?, ?, 'claude {{prompt}}')`);
  insertAgent.run('agent-1', 'Custom Agent');

  const insertSession = bunDb.prepare(
    `INSERT INTO sessions (id, type, location_path) VALUES (?, 'quick', '/tmp/session')`
  );
  insertSession.run('session-1');
  insertSession.run('session-2');

  const insertRepo = bunDb.prepare(
    `INSERT INTO repositories (id, name, path, created_at, updated_at, setup_command, env_vars,
       description, cleanup_command, default_agent_id, orchestrator_session_id, issue_trigger_labels)
     VALUES (?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const repo of options.repositories) {
    insertRepo.run(
      repo.id,
      repo.name,
      repo.path,
      repo.setup_command,
      repo.env_vars,
      repo.description,
      repo.cleanup_command,
      repo.default_agent_id,
      repo.orchestrator_session_id,
      repo.issue_trigger_labels
    );
  }

  return db;
}

const FULL_ROW: SeedRepository = {
  id: 'repo-full',
  name: 'Full Repo',
  path: '/repos/full',
  setup_command: 'npm install',
  env_vars: 'FOO=bar',
  description: 'A fully-configured repository',
  cleanup_command: 'docker compose down',
  default_agent_id: 'agent-1',
  orchestrator_session_id: null,
  issue_trigger_labels: 'bug, needs-triage',
};

const MINIMAL_ROW: SeedRepository = {
  id: 'repo-minimal',
  name: 'Minimal Repo',
  path: '/repos/minimal',
  setup_command: null,
  env_vars: null,
  description: null,
  cleanup_command: null,
  default_agent_id: null,
  orchestrator_session_id: null,
  issue_trigger_labels: null,
};

describe('migration v42 (drop dead repositories.orchestrator_session_id)', () => {
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

  it('advances the schema version to 42 via the real production migration path', async () => {
    // KEEP THIS despite its resemblance to the terminal-version assertions
    // #1405 removed from every other migration-vNN test, per
    // `migration-v36.test.ts`'s own header note: this asserts what v42
    // ITSELF sets (`PRAGMA user_version = 42`), which is v42's own effect
    // and nobody else's -- `migration.test.ts` owns the CHAIN's final
    // version (and its own `toBe(41)` assertions were bumped to 42 in this
    // PR, since `initializeDatabase(':memory:')` now runs through v42 too).
    const db = seedV41Database({ repositories: [] });
    await migrateToV42(db);
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(42);
    await db.destroy();
  });

  it('runs through the real dispatcher (runMigrations) and lands on 43 from a fresh database', async () => {
    // `runMigrations` is module-internal (not exported), so this exercises
    // it via the real `initializeDatabase(':memory:')` entrypoint -- the
    // "migration.test.ts style" full-chain check, scoped to this file for
    // v42's own dispatch integration. Migration v43 (sessions ISO8601 CHECK
    // rebuild) now also runs unconditionally after v42 in the same
    // dispatcher chain, so a fresh database lands one step further than
    // v42's own step -- this asserts the CHAIN's landing point, not v42's
    // own effect (which the "advances the schema version to 42" test above
    // already isolates via a direct `migrateToV42(db)` call).
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(43);
  });

  it('drops orchestrator_session_id and reproduces the live DDL exactly: both ISO8601 CHECK constraints survive', async () => {
    // Uses the shared `expectRebuiltTableDdl` helper (packages/server/src/
    // database/__tests__/helpers/ddl-pin.ts), replacing what were previously
    // two separate inline tests here: a `PRAGMA table_info`-based
    // column-shape pin (which does not surface table-level CHECK
    // constraints, so a dropped CHECK would pass it silently) and a
    // `sqlite_master.sql`-text pin for the CHECK constraints specifically.
    // The helper asserts both in one call, preserving every assertion the
    // two original tests made. Polarity: renaming `repositories` itself
    // (instead of `repositories_new`) or skipping a column in the explicit
    // INSERT column list would leave the column set wrong; dropping either
    // CONSTRAINT clause from `migrateToV42`'s CREATE TABLE fails the
    // `mustContain` checks below without touching the column-shape checks.
    const db = seedV41Database({ repositories: [] });
    await migrateToV42(db);

    await expectRebuiltTableDdl(db, 'repositories', {
      expectedColumns: [
        { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: 'path', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        // `PRAGMA table_info`'s `dflt_value` strips one level of the
        // enclosing parens the CREATE TABLE text itself carries around a
        // function-call DEFAULT (confirmed empirically against this exact
        // migration's output; `sqlite_master.sql`, asserted via
        // `mustContain` below, keeps the parens).
        { cid: 3, name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", pk: 0 },
        { cid: 4, name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", pk: 0 },
        { cid: 5, name: 'setup_command', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 6, name: 'env_vars', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 7, name: 'description', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 8, name: 'cleanup_command', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 9, name: 'default_agent_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 10, name: 'issue_trigger_labels', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      ],
      mustContain: ['repositories_created_at_iso8601', 'repositories_updated_at_iso8601', "GLOB '????-??-??T??:??:??*Z'"],
      mustNotContain: ['orchestrator_session_id'],
    });

    await db.destroy();
  });

  it('the ISO8601 CHECK constraint survives functionally, not only in its text', async () => {
    // Behavioural pin, distinct from the DDL-text pin above: a CHECK
    // constraint whose CONSTRAINT clause text is reproduced but whose
    // GLOB pattern was subtly altered (e.g. dropping the `IS NULL OR`
    // escape) would still pass the text-containment assertion above while
    // failing to actually validate inserts.
    const db = seedV41Database({ repositories: [] });
    await migrateToV42(db);

    await expect(
      db
        .insertInto('repositories')
        .values({
          id: 'repo-bad-timestamp',
          name: 'Bad Timestamp',
          path: '/repos/bad-timestamp',
          created_at: 'not-a-timestamp',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute()
    ).rejects.toThrow();

    // A well-formed ISO 8601 value is still accepted after the rebuild
    // (the CHECK constraint is not simply rejecting every insert).
    await db
      .insertInto('repositories')
      .values({
        id: 'repo-good-timestamp',
        name: 'Good Timestamp',
        path: '/repos/good-timestamp',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      })
      .execute();

    const row = await db
      .selectFrom('repositories')
      .where('id', '=', 'repo-good-timestamp')
      .select(['created_at'])
      .executeTakeFirstOrThrow();
    expect(row.created_at).toBe('2024-01-01T00:00:00.000Z');

    await db.destroy();
  });

  describe('FK hazard: dependent tables still reference `repositories`, not `repositories_new`', () => {
    it('foreign_key_list on every dependent table still names table repositories, and foreign_key_check is empty', async () => {
      const db = seedV41Database({ repositories: [FULL_ROW] });
      await migrateToV42(db);

      for (const tbl of ['worktrees', 'repository_slack_integrations', 'repository_orchestrator_sessions']) {
        // `repository_orchestrator_sessions` has TWO foreign keys
        // (repository_id -> repositories, session_id -> sessions), so this
        // filters for the one this migration's rename step could have
        // silently repointed, rather than asserting every FK row targets
        // `repositories`.
        const fkRows = await sql<{ table: string; from: string }>`PRAGMA foreign_key_list(${sql.raw(tbl)})`.execute(db);
        const repositoryFk = fkRows.rows.find((fk) => fk.from === 'repository_id');
        expect(repositoryFk, `${tbl}'s repository_id FK`).toBeDefined();
        expect(repositoryFk!.table, `${tbl}'s repository_id FK target table`).toBe('repositories');
      }

      const fkCheck = await sql`PRAGMA foreign_key_check`.execute(db);
      expect(fkCheck.rows).toEqual([]);

      await db.destroy();
    });

    it('CASCADE still works after the rebuild: deleting one repository removes only its own children', async () => {
      const db = seedV41Database({ repositories: [FULL_ROW, MINIMAL_ROW] });
      await sql`PRAGMA foreign_keys = ON`.execute(db);

      await db
        .insertInto('worktrees')
        .values([
          { id: 'wt-full', repository_id: 'repo-full', path: '/wt/full', index_number: 1 },
          { id: 'wt-minimal', repository_id: 'repo-minimal', path: '/wt/minimal', index_number: 1 },
        ])
        .execute();
      await db
        .insertInto('repository_slack_integrations')
        .values({
          id: 'slack-full',
          repository_id: 'repo-full',
          webhook_url: 'https://hooks.slack.com/services/T00/B00/full',
          enabled: 1,
        })
        .execute();
      await db
        .insertInto('repository_orchestrator_sessions')
        .values([
          { repository_id: 'repo-full', session_id: 'session-1' },
          { repository_id: 'repo-full', session_id: 'session-2' },
        ])
        .execute();

      await migrateToV42(db);
      await sql`PRAGMA foreign_keys = ON`.execute(db);

      await db.deleteFrom('repositories').where('id', '=', 'repo-full').execute();

      const worktrees = await db.selectFrom('worktrees').selectAll().execute();
      expect(worktrees.map((w) => w.id)).toEqual(['wt-minimal']);

      const integrations = await db.selectFrom('repository_slack_integrations').selectAll().execute();
      expect(integrations).toHaveLength(0);

      const designations = await db.selectFrom('repository_orchestrator_sessions').selectAll().execute();
      expect(designations).toHaveLength(0);

      // The other repository and its (non-existent) children are untouched.
      const remaining = await db.selectFrom('repositories').selectAll().execute();
      expect(remaining.map((r) => r.id)).toEqual(['repo-minimal']);

      await db.destroy();
    });
  });

  it("default_agent_id's ON DELETE SET NULL survives the rebuild", async () => {
    const db = seedV41Database({ repositories: [FULL_ROW] });
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    await migrateToV42(db);
    await sql`PRAGMA foreign_keys = ON`.execute(db);

    let row = await db
      .selectFrom('repositories')
      .where('id', '=', 'repo-full')
      .select(['default_agent_id'])
      .executeTakeFirstOrThrow();
    expect(row.default_agent_id).toBe('agent-1');

    await db.deleteFrom('agents').where('id', '=', 'agent-1').execute();

    row = await db
      .selectFrom('repositories')
      .where('id', '=', 'repo-full')
      .select(['default_agent_id'])
      .executeTakeFirstOrThrow();
    expect(row.default_agent_id).toBeNull();

    await db.destroy();
  });

  it('preserves every other column of every row through the rebuild', async () => {
    const db = seedV41Database({ repositories: [FULL_ROW, MINIMAL_ROW] });
    await migrateToV42(db);

    const rows = await db.selectFrom('repositories').selectAll().orderBy('id').execute();
    expect(rows).toHaveLength(2);

    const [fullRow, minimalRow] = rows;
    expect(fullRow.id).toBe('repo-full');
    expect(fullRow.name).toBe('Full Repo');
    expect(fullRow.path).toBe('/repos/full');
    expect(fullRow.created_at).toBe('2024-01-01T00:00:00.000Z');
    expect(fullRow.updated_at).toBe('2024-01-02T00:00:00.000Z');
    expect(fullRow.setup_command).toBe('npm install');
    expect(fullRow.env_vars).toBe('FOO=bar');
    expect(fullRow.description).toBe('A fully-configured repository');
    expect(fullRow.cleanup_command).toBe('docker compose down');
    expect(fullRow.default_agent_id).toBe('agent-1');
    expect(fullRow.issue_trigger_labels).toBe('bug, needs-triage');

    expect(minimalRow.id).toBe('repo-minimal');
    expect(minimalRow.setup_command).toBeNull();
    expect(minimalRow.env_vars).toBeNull();
    expect(minimalRow.description).toBeNull();
    expect(minimalRow.cleanup_command).toBeNull();
    expect(minimalRow.default_agent_id).toBeNull();
    expect(minimalRow.issue_trigger_labels).toBeNull();

    await db.destroy();
  });

  it("preserves the path UNIQUE constraint: a duplicate insert throws after the rebuild", async () => {
    const db = seedV41Database({ repositories: [FULL_ROW] });
    await migrateToV42(db);

    await expect(
      db
        .insertInto('repositories')
        .values({
          id: 'repo-duplicate-path',
          name: 'Duplicate Path',
          path: FULL_ROW.path,
        })
        .execute()
    ).rejects.toThrow();

    await db.destroy();
  });

  it('is a no-op when re-applied (already at v42)', async () => {
    const db = seedV41Database({ repositories: [FULL_ROW] });
    await migrateToV42(db);
    await expect(migrateToV42(db)).resolves.toBeUndefined();

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(42);

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(repositories)`.execute(db);
    expect(columns.rows.filter((c) => c.name === 'orchestrator_session_id')).toHaveLength(0);

    const rows = await db.selectFrom('repositories').selectAll().execute();
    expect(rows).toHaveLength(1);

    await db.destroy();
  });

  it('rebuilds without error when orchestrator_session_id is non-NULL on some row (the pre-v41-backfill shape, defensive)', async () => {
    // Not the production shape (v41 always clears it to NULL before this
    // migration ever runs), but defensive: the rebuild's explicit-column
    // INSERT simply never names the column, so a stray non-NULL value is
    // dropped rather than causing an error.
    const db = seedV41Database({
      repositories: [{ ...FULL_ROW, orchestrator_session_id: 'session-1' }],
    });
    await sql`PRAGMA foreign_keys = ON`.execute(db);

    await expect(migrateToV42(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(repositories)`.execute(db);
    expect(columns.rows.some((c) => c.name === 'orchestrator_session_id')).toBe(false);

    const row = await db
      .selectFrom('repositories')
      .where('id', '=', 'repo-full')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect((row as Record<string, unknown>).orchestrator_session_id).toBeUndefined();

    await db.destroy();
  });

  describe('pre-flight database backup', () => {
    // Mirrors migration-v19.test.ts's backup describe block: the Kysely
    // database used to drive the migration is independent of the memfs file
    // at `dbPath` (Bun's native SQLite cannot read memfs paths); the
    // migration only needs `dbPath` to know WHERE to write the backup.
    it('takes a backup before migrating and proceeds with migration', async () => {
      const dbPath = `${TEST_CONFIG_DIR}/agentconsole.db`;
      const fakeDbBytes = 'SQLITE format 3 -pretend-db-content';
      setupMemfs({
        [dbPath]: fakeDbBytes,
      });

      const db = seedV41Database({ repositories: [FULL_ROW] });
      await migrateToV42(db, dbPath);

      const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
      expect(versionRes.rows[0]?.user_version).toBe(42);

      const dirEntries = await fsPromises.readdir(TEST_CONFIG_DIR);
      const backups = dirEntries.filter((name) => name.startsWith('agentconsole.db.bak.v41-to-v42.'));
      expect(backups).toHaveLength(1);

      const backupName = backups[0];
      expect(backupName).toMatch(
        /^agentconsole\.db\.bak\.v41-to-v42\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
      );

      const backupContent = await fsPromises.readFile(`${TEST_CONFIG_DIR}/${backupName}`, 'utf-8');
      expect(backupContent).toBe(fakeDbBytes);

      await db.destroy();
    });

    it('aborts the migration when the backup copy fails', async () => {
      const dbPath = `${TEST_CONFIG_DIR}/agentconsole.db`;
      setupMemfs({
        [dbPath]: 'irrelevant',
      });

      const db = seedV41Database({ repositories: [FULL_ROW] });

      const copySpy = spyOn(fsPromises, 'copyFile').mockImplementation(() => {
        return Promise.reject(new Error('disk full'));
      });

      try {
        await expect(migrateToV42(db, dbPath)).rejects.toThrow('disk full');

        const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(versionRes.rows[0]?.user_version).toBe(41);

        const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(repositories)`.execute(db);
        expect(columns.rows.some((c) => c.name === 'orchestrator_session_id')).toBe(true);
      } finally {
        copySpy.mockRestore();
      }

      await db.destroy();
    });

    it('skips the backup for in-memory databases', async () => {
      const db = seedV41Database({ repositories: [] });

      const copySpy = spyOn(fsPromises, 'copyFile');

      try {
        await migrateToV42(db, ':memory:');
        expect(copySpy).not.toHaveBeenCalled();

        const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(versionRes.rows[0]?.user_version).toBe(42);
      } finally {
        copySpy.mockRestore();
      }

      await db.destroy();
    });

    it('backupDatabaseFile returns null and performs no copy for in-memory databases', async () => {
      const copySpy = spyOn(fsPromises, 'copyFile');

      try {
        const result = await backupDatabaseFile(':memory:', 41, 42);
        expect(result).toBeNull();
        expect(copySpy).not.toHaveBeenCalled();
      } finally {
        copySpy.mockRestore();
      }
    });
  });
});
