/**
 * Tests for repository-factory.ts.
 *
 * `createSessionRepository()` returns a SqliteSessionRepository on all three
 * branches (existing data.db / sessions.json migration / fresh install) --
 * the branches only differ in which log line is emitted, so these tests
 * pin the returned repository type and the observable filesystem effect
 * (the db file existing afterwards), not log output.
 *
 * Two filesystem layers are in play here, and both must be kept in sync:
 *   - REAL disk: `databaseExists()` / the factory's sessions.json probe use
 *     `Bun.file(...).exists()`, and `bun:sqlite`'s `BunDatabase` opens the
 *     db file directly -- all of these deliberately bypass `fs` module
 *     mocks (see `databaseExists()`'s own JSDoc in database/connection.ts).
 *   - ACTIVE fs (`node:fs` / `fs/promises` as currently imported): this is
 *     memfs when a sibling test file in the same process has installed the
 *     process-global mock via `__tests__/utils/mock-fs-helper.ts` (e.g. when
 *     running the whole `repositories/__tests__/` directory together with
 *     `json-session-repository.test.ts`), and the real disk otherwise (when
 *     this file runs alone). `doInitializeDatabase()`'s config-dir
 *     existence check/mkdir and `migrateFromJson()` read through this
 *     layer, and `JsonSessionRepository` reads/writes through it exclusively.
 * `configDir` is therefore materialized on BOTH layers in `beforeEach`, and
 * torn down on both in `afterEach`.
 *
 * A third wrinkle in the `createSessionRepository` cases specifically: a
 * brand-new database always passes through `migrateToV19` / `migrateToV42`
 * on its way to the latest schema version, and BOTH of those unconditionally
 * take a pre-flight backup of the real (non-`:memory:`) db file via
 * `fs/promises.copyFile(dbPath, backupPath)` -- reading through whichever
 * `fs/promises` is currently bound. Under a mocked (memfs) `fs` this fails,
 * because `bun:sqlite` always writes to real disk regardless of the mock, so
 * the active (memfs) layer has nothing at `dbPath` to copy.
 *
 * `seedDbBackupSourcePlaceholder()` below writes a 0-byte placeholder at
 * `dbPath` to give that copy a source under memfs -- but ONLY when memfs is
 * actually active (detected via `isMemfsActive()`, an existing `/proc`
 * sentinel helper). It must NEVER write to the real disk: `databaseExists()`
 * reads real disk via `Bun.file` unconditionally, so an unconditional write
 * would make it observe an existing (placeholder) db file before
 * `createSessionRepository()` ever runs, silently steering the call onto the
 * "existing database" branch instead of the branch each test claims to
 * exercise -- turning the trailing `expect(await databaseExists()).toBe(true)`
 * into a vacuous assertion satisfied by the placeholder rather than by the
 * factory. Under a real (unmocked) `fs`, nothing is written here and
 * `bun:sqlite` creates the real file itself before migrations run, so the
 * real-disk backup copy just works unassisted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closeDatabase, databaseExists } from '../../database/index.js';
import { SqliteSessionRepository } from '../sqlite-session-repository.js';
import { JsonSessionRepository } from '../json-session-repository.js';
import { createSessionRepository, createJsonSessionRepository } from '../repository-factory.js';
import { buildPersistedQuickSession } from '../../__tests__/utils/build-test-data.js';
import { isMemfsActive } from '../../__tests__/utils/memfs-detection.js';

describe('repository-factory', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  let configDir: string;

  beforeEach(async () => {
    await closeDatabase();
    configDir = path.join(os.tmpdir(), `agent-console-repo-factory-${crypto.randomUUID()}`);

    // Real disk: `Bun.write` creates parent directories and always targets
    // the real filesystem, regardless of any active `fs` mock.
    await Bun.write(path.join(configDir, '.keep'), '');
    // Active layer: memfs when a sibling test file has mocked `fs` in this
    // process, otherwise the same real directory as above (redundant but
    // harmless in that case).
    fs.mkdirSync(configDir, { recursive: true });

    process.env.AGENT_CONSOLE_HOME = configDir;
  });

  afterEach(async () => {
    await closeDatabase();
    if (originalHome === undefined) {
      delete process.env.AGENT_CONSOLE_HOME;
    } else {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    }

    // Active layer cleanup (memfs or real disk, whichever is active).
    fs.rmSync(configDir, { recursive: true, force: true });
    // Real-disk cleanup: always required, since `bun:sqlite` and `Bun.file`
    // write real files under `configDir` regardless of the active `fs` mock.
    await Bun.$`rm -rf ${configDir}`.quiet();
  });

  /**
   * See the file header for why this exists. Writes a 0-byte placeholder at
   * `dbPath` through the ACTIVE `fs` -- but ONLY when memfs is active -- so
   * the v19/v42 migration backup's `fs/promises.copyFile` has a source.
   * Under a real (unmocked) `fs` this is a deliberate no-op: `bun:sqlite`
   * creates the real file itself, and writing here would instead make
   * `databaseExists()` (real disk) observe the db as already present,
   * silently steering `createSessionRepository()` onto the "existing
   * database" branch instead of the branch under test. Call this AFTER any
   * "database does not exist yet" assertion and BEFORE the first
   * `createSessionRepository()` call in a test.
   */
  async function seedDbBackupSourcePlaceholder(): Promise<void> {
    if (await isMemfsActive()) {
      fs.writeFileSync(path.join(configDir, 'data.db'), '');
    }
  }

  describe('createSessionRepository', () => {
    it('returns a SqliteSessionRepository on a fresh install and creates the db under the config dir', async () => {
      expect(await databaseExists()).toBe(false);
      await seedDbBackupSourcePlaceholder();
      // Pins the reach of the placeholder: it must never leak onto real
      // disk. True under BOTH modes -- under memfs the placeholder landed
      // only in the mocked layer; under real fs nothing was written at all.
      // A placeholder that leaked onto real disk would flip this to true
      // and the branch under test below would silently change.
      expect(await databaseExists()).toBe(false);

      const repository = await createSessionRepository();

      expect(repository).toBeInstanceOf(SqliteSessionRepository);
      expect(await databaseExists()).toBe(true);
    });

    it('returns a SqliteSessionRepository when sessions.json exists but no db yet (migrate branch)', async () => {
      // The factory's sessions.json probe reads via `Bun.file(...).exists()`
      // (real disk), so the seed file must be written there too.
      await Bun.write(path.join(configDir, 'sessions.json'), '[]');
      expect(await databaseExists()).toBe(false);
      await seedDbBackupSourcePlaceholder();

      const repository = await createSessionRepository();

      expect(repository).toBeInstanceOf(SqliteSessionRepository);
      expect(await databaseExists()).toBe(true);
    });

    it('returns a SqliteSessionRepository when a db already exists', async () => {
      // First call goes through the fresh-install branch and creates the db.
      await seedDbBackupSourcePlaceholder();
      await createSessionRepository();
      await closeDatabase();
      expect(await databaseExists()).toBe(true);

      // Second call must go through the "existing database" branch.
      const repository = await createSessionRepository();

      expect(repository).toBeInstanceOf(SqliteSessionRepository);
    });
  });

  describe('createJsonSessionRepository', () => {
    it('binds to the given path: data written via save() is visible to a fresh repository at the same path', async () => {
      const filePath = path.join(configDir, 'custom-sessions.json');
      const repository = createJsonSessionRepository(filePath);
      expect(repository).toBeInstanceOf(JsonSessionRepository);

      const session = buildPersistedQuickSession({ id: 'session-1' });
      await repository.save(session);

      const reopened = createJsonSessionRepository(filePath);
      const all = await reopened.findAll();
      expect(all.map((s) => s.id)).toEqual(['session-1']);
    });

    it('defaults to <configDir>/sessions.json when no path is given', async () => {
      const repository = createJsonSessionRepository();

      const session = buildPersistedQuickSession({ id: 'session-default' });
      await repository.save(session);

      const reopened = createJsonSessionRepository();
      const all = await reopened.findAll();
      expect(all.map((s) => s.id)).toEqual(['session-default']);
    });
  });
});
