/**
 * Tests for SingleUserMode with UserRepository integration.
 *
 * Verifies that:
 * - SingleUserMode.create() upserts the server process user
 * - authenticate() returns AuthUser with stable id
 * - login() returns AuthUser with stable id
 * - Direct constructor works for tests with pre-built AuthUser
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SingleUserMode } from '../user-mode.js';
import type { PtyProvider } from '../../lib/pty-provider.js';

const mockPtyProvider: PtyProvider = {
  spawn: () => { throw new Error('not implemented'); },
};

describe('SingleUserMode', () => {
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createDatabaseForTest();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('create() factory method', () => {
    it('should upsert server process user and cache result', async () => {
      const userRepository = new SqliteUserRepository(db);
      const userMode = await SingleUserMode.create(mockPtyProvider, userRepository);

      const authUser = userMode.authenticate(() => undefined);

      // Should have a valid UUID
      expect(authUser).not.toBeNull();
      expect(authUser!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(authUser!.username).toBeDefined();
      expect(authUser!.homeDir).toBeDefined();
    });

    it('should return same id on repeated calls (stable identity)', async () => {
      const userRepository = new SqliteUserRepository(db);

      const mode1 = await SingleUserMode.create(mockPtyProvider, userRepository);
      const mode2 = await SingleUserMode.create(mockPtyProvider, userRepository);

      const user1 = mode1.authenticate(() => undefined);
      const user2 = mode2.authenticate(() => undefined);

      // Same OS UID -> same user ID
      expect(user1!.id).toBe(user2!.id);
    });

    it('should persist user to database', async () => {
      const userRepository = new SqliteUserRepository(db);
      const userMode = await SingleUserMode.create(mockPtyProvider, userRepository);

      const authUser = userMode.authenticate(() => undefined)!;

      // Verify user exists in database
      const found = await userRepository.findById(authUser.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(authUser.id);
      expect(found!.username).toBe(authUser.username);
    });
  });

  describe('authenticate()', () => {
    it('should always return cached user (ignores token)', async () => {
      const cachedUser = { id: 'cached-id', username: 'cached', homeDir: '/home/cached' };
      const userMode = new SingleUserMode(mockPtyProvider, cachedUser);

      // Should return cached user regardless of token
      const result1 = userMode.authenticate(() => undefined);
      const result2 = userMode.authenticate(() => 'some-token');

      expect(result1).toEqual(cachedUser);
      expect(result2).toEqual(cachedUser);
    });

    it('should include id in returned AuthUser', async () => {
      const cachedUser = { id: 'test-uuid-123', username: 'testuser', homeDir: '/home/test' };
      const userMode = new SingleUserMode(mockPtyProvider, cachedUser);

      const result = userMode.authenticate(() => undefined);
      expect(result!.id).toBe('test-uuid-123');
    });
  });

  describe('login()', () => {
    it('should return null (login is not a valid operation in single-user mode)', async () => {
      const cachedUser = { id: 'cached-id', username: 'cached', homeDir: '/home/cached' };
      const userMode = new SingleUserMode(mockPtyProvider, cachedUser);

      const result = await userMode.login('any-user', 'any-password');

      expect(result).toBeNull();
    });
  });
});
