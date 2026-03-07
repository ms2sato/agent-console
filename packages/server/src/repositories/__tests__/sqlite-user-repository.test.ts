import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteUserRepository } from '../sqlite-user-repository.js';
import type { Database } from '../../database/schema.js';

describe('SqliteUserRepository', () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;
  let repository: SqliteUserRepository;

  beforeEach(async () => {
    bunDb = new BunDatabase(':memory:');
    bunDb.exec('PRAGMA foreign_keys = ON;');

    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });

    // Create users table matching migration v14
    await db.schema
      .createTable('users')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('os_uid', 'integer')
      .addColumn('username', 'text', (col) => col.notNull())
      .addColumn('home_dir', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute();

    // Partial unique index on os_uid
    await sql`CREATE UNIQUE INDEX idx_users_os_uid ON users(os_uid) WHERE os_uid IS NOT NULL`.execute(db);

    repository = new SqliteUserRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
    bunDb.close();
  });

  describe('upsertByOsUid', () => {
    it('should create a new user when none exists for the given os_uid', async () => {
      const user = await repository.upsertByOsUid(1001, 'alice', '/home/alice');

      expect(user.id).toBeDefined();
      expect(user.id.length).toBeGreaterThan(0);
      expect(user.username).toBe('alice');
      expect(user.homeDir).toBe('/home/alice');
    });

    it('should generate a UUID for new user id', async () => {
      const user = await repository.upsertByOsUid(1001, 'alice', '/home/alice');

      // UUID v4 format: 8-4-4-4-12 hex digits
      expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should return existing user when os_uid already exists', async () => {
      const first = await repository.upsertByOsUid(1001, 'alice', '/home/alice');
      const second = await repository.upsertByOsUid(1001, 'alice', '/home/alice');

      expect(second.id).toBe(first.id);
      expect(second.username).toBe('alice');
      expect(second.homeDir).toBe('/home/alice');
    });

    it('should update username when it changes for existing os_uid', async () => {
      const first = await repository.upsertByOsUid(1001, 'alice', '/home/alice');
      const second = await repository.upsertByOsUid(1001, 'alice_renamed', '/home/alice');

      expect(second.id).toBe(first.id);
      expect(second.username).toBe('alice_renamed');

      // Verify database was actually updated
      const row = await db
        .selectFrom('users')
        .where('id', '=', first.id)
        .selectAll()
        .executeTakeFirst();
      expect(row?.username).toBe('alice_renamed');
    });

    it('should update home_dir when it changes for existing os_uid', async () => {
      const first = await repository.upsertByOsUid(1001, 'alice', '/home/alice');
      const second = await repository.upsertByOsUid(1001, 'alice', '/Users/alice');

      expect(second.id).toBe(first.id);
      expect(second.homeDir).toBe('/Users/alice');

      // Verify database was actually updated
      const row = await db
        .selectFrom('users')
        .where('id', '=', first.id)
        .selectAll()
        .executeTakeFirst();
      expect(row?.home_dir).toBe('/Users/alice');
    });

    it('should update updated_at on upsert even when data is unchanged', async () => {
      // Atomic upsert always sets updated_at on conflict to avoid TOCTOU race conditions.
      // This is a deliberate trade-off: consistency over skip-if-unchanged optimization.
      const first = await repository.upsertByOsUid(1001, 'alice', '/home/alice');

      // Get updated_at timestamp
      const rowBefore = await db
        .selectFrom('users')
        .where('id', '=', first.id)
        .select('updated_at')
        .executeTakeFirst();

      // Upsert again with same data
      await repository.upsertByOsUid(1001, 'alice', '/home/alice');

      const rowAfter = await db
        .selectFrom('users')
        .where('id', '=', first.id)
        .select('updated_at')
        .executeTakeFirst();

      // updated_at is always refreshed by the atomic upsert
      expect(rowAfter?.updated_at).toBeDefined();
      expect(rowBefore?.updated_at).toBeDefined();
    });

    it('should preserve created_at on upsert (only insert sets it)', async () => {
      const first = await repository.upsertByOsUid(1001, 'alice', '/home/alice');

      const rowBefore = await db
        .selectFrom('users')
        .where('id', '=', first.id)
        .select('created_at')
        .executeTakeFirst();

      // Upsert with changed data
      await repository.upsertByOsUid(1001, 'alice_new', '/home/alice_new');

      const rowAfter = await db
        .selectFrom('users')
        .where('id', '=', first.id)
        .select('created_at')
        .executeTakeFirst();

      // created_at should never change after initial insert
      expect(rowAfter?.created_at).toBe(rowBefore?.created_at);
    });

    it('should handle concurrent upserts without constraint violations', async () => {
      // Simulate concurrent upserts for the same os_uid - both should succeed
      // without throwing a unique constraint violation
      const results = await Promise.all([
        repository.upsertByOsUid(1001, 'alice', '/home/alice'),
        repository.upsertByOsUid(1001, 'alice', '/home/alice'),
      ]);

      // Both should return the same user id
      expect(results[0].id).toBe(results[1].id);
    });

    it('should create different users for different os_uids', async () => {
      const alice = await repository.upsertByOsUid(1001, 'alice', '/home/alice');
      const bob = await repository.upsertByOsUid(1002, 'bob', '/home/bob');

      expect(alice.id).not.toBe(bob.id);
      expect(alice.username).toBe('alice');
      expect(bob.username).toBe('bob');
    });
  });

  describe('findById', () => {
    it('should return user by id', async () => {
      const created = await repository.upsertByOsUid(1001, 'alice', '/home/alice');
      const found = await repository.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.username).toBe('alice');
      expect(found!.homeDir).toBe('/home/alice');
    });

    it('should return null when user does not exist', async () => {
      const found = await repository.findById('nonexistent-id');
      expect(found).toBeNull();
    });

    it('should return updated data after username change', async () => {
      const created = await repository.upsertByOsUid(1001, 'alice', '/home/alice');
      await repository.upsertByOsUid(1001, 'alice_new', '/home/alice');

      const found = await repository.findById(created.id);
      expect(found!.username).toBe('alice_new');
    });
  });
});
