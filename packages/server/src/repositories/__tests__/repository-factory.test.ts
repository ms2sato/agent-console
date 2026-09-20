/**
 * Tests for repository-factory.ts.
 *
 * `createSessionRepository()` returns a SqliteSessionRepository on all three
 * branches (existing data.db / sessions.json migration / fresh install) --
 * the branches only differ in which log line is emitted, so these tests
 * pin the returned repository type and the observable filesystem effect
 * (the db file existing afterwards), not log output.
 *
 * Uses a REAL temp directory (not memfs): `databaseExists()` reads via
 * `Bun.file(...).exists()`, which deliberately bypasses fs module mocks
 * (see its JSDoc in database/connection.ts), and `bun:sqlite`'s
 * `BunDatabase` always writes to real disk regardless of the configured
 * path. Memfs would therefore desync from what these functions actually
 * observe.
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

describe('repository-factory', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  let configDir: string;

  beforeEach(async () => {
    await closeDatabase();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-repo-factory-'));
    process.env.AGENT_CONSOLE_HOME = configDir;
  });

  afterEach(async () => {
    await closeDatabase();
    if (originalHome === undefined) {
      delete process.env.AGENT_CONSOLE_HOME;
    } else {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  describe('createSessionRepository', () => {
    it('returns a SqliteSessionRepository on a fresh install and creates the db under the config dir', async () => {
      expect(await databaseExists()).toBe(false);

      const repository = await createSessionRepository();

      expect(repository).toBeInstanceOf(SqliteSessionRepository);
      expect(await databaseExists()).toBe(true);
    });

    it('returns a SqliteSessionRepository when sessions.json exists but no db yet (migrate branch)', async () => {
      fs.writeFileSync(path.join(configDir, 'sessions.json'), JSON.stringify([]));
      expect(await databaseExists()).toBe(false);

      const repository = await createSessionRepository();

      expect(repository).toBeInstanceOf(SqliteSessionRepository);
      expect(await databaseExists()).toBe(true);
    });

    it('returns a SqliteSessionRepository when a db already exists', async () => {
      // First call goes through the fresh-install branch and creates the db.
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

      expect(fs.existsSync(filePath)).toBe(true);

      const reopened = createJsonSessionRepository(filePath);
      const all = await reopened.findAll();
      expect(all.map((s) => s.id)).toEqual(['session-1']);
    });

    it('defaults to <configDir>/sessions.json when no path is given', async () => {
      const repository = createJsonSessionRepository();

      const session = buildPersistedQuickSession({ id: 'session-default' });
      await repository.save(session);

      const defaultPath = path.join(configDir, 'sessions.json');
      expect(fs.existsSync(defaultPath)).toBe(true);

      const reopened = createJsonSessionRepository();
      const all = await reopened.findAll();
      expect(all.map((s) => s.id)).toEqual(['session-default']);
    });
  });
});
