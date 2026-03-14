/**
 * Tests for resolveSpawnUsername.
 *
 * Tests the real exported function directly, not re-implemented logic.
 * Verifies the three resolution paths:
 * 1. createdBy is undefined → falls back to os.userInfo().username
 * 2. createdBy is set but user not found in DB → falls back to os.userInfo().username
 * 3. createdBy is set and user found in DB → returns that user's username
 *
 * The "no userRepository" path (userRepository is null) is also tested.
 */
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { resolveSpawnUsername } from '../resolve-spawn-username.js';

describe('resolveSpawnUsername', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('should fall back to os.userInfo().username when createdBy is undefined', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);

    const result = await resolveSpawnUsername(undefined, userRepository);
    expect(result).toBe(os.userInfo().username);
  });

  it('should fall back to os.userInfo().username when userRepository is null', async () => {
    const result = await resolveSpawnUsername('some-user-id', null);
    expect(result).toBe(os.userInfo().username);
  });

  it('should fall back to os.userInfo().username when user is not found in DB', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);

    const result = await resolveSpawnUsername('non-existent-user-id', userRepository);
    expect(result).toBe(os.userInfo().username);
  });

  it('should return the DB user username when user is found in DB', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);

    const authUser = await userRepository.upsertByOsUid(9999, 'dbuser', '/home/dbuser');

    const result = await resolveSpawnUsername(authUser.id, userRepository);
    expect(result).toBe('dbuser');
  });
});
