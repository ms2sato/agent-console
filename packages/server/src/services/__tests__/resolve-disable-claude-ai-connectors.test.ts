/**
 * Tests for resolveDisableClaudeAiConnectors.
 *
 * Tests the real exported function directly, not re-implemented logic.
 *
 * Resolution paths:
 * 1. userRepository is null -> false (silent default) + a structured warn
 * 2. userId does not resolve to a row (getPreferences returns null) ->
 *    false + a structured warn
 * 3. userId resolves to a row -> that row's disableClaudeAiConnectors value
 *    (true and false both asserted), no warn required
 * 4. getPreferences THROWS -> propagates uncaught, never swallowed to false
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import type { UserRepository } from '../../repositories/user-repository.js';
import { resolveDisableClaudeAiConnectors } from '../resolve-disable-claude-ai-connectors.js';

describe('resolveDisableClaudeAiConnectors', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('returns false when userRepository is null', async () => {
    const result = await resolveDisableClaudeAiConnectors('user-1', null);
    expect(result).toBe(false);
  });

  it('returns false when the user row does not exist', async () => {
    const db = getDatabase();
    const repository = new SqliteUserRepository(db);

    const result = await resolveDisableClaudeAiConnectors('nonexistent-user', repository);
    expect(result).toBe(false);
  });

  it('returns true when the user row has disableClaudeAiConnectors: true', async () => {
    const db = getDatabase();
    const repository = new SqliteUserRepository(db);
    const user = await repository.upsertByOsUid(2001, 'alice', '/home/alice');
    await repository.setPreferences(user.id, { disableClaudeAiConnectors: true });

    const result = await resolveDisableClaudeAiConnectors(user.id, repository);
    expect(result).toBe(true);
  });

  it('returns false when the user row has disableClaudeAiConnectors: false', async () => {
    const db = getDatabase();
    const repository = new SqliteUserRepository(db);
    const user = await repository.upsertByOsUid(2002, 'bob', '/home/bob');
    // Never explicitly set -- exercises the migration's own default.

    const result = await resolveDisableClaudeAiConnectors(user.id, repository);
    expect(result).toBe(false);
  });

  it('propagates a throwing getPreferences call uncaught -- never swallowed to false', async () => {
    const throwingRepository: UserRepository = {
      upsertByOsUid: async () => {
        throw new Error('not used in this test');
      },
      findById: async () => null,
      getPreferences: async () => {
        throw new Error('simulated repository failure');
      },
      setPreferences: async () => true,
    };

    await expect(resolveDisableClaudeAiConnectors('user-1', throwingRepository)).rejects.toThrow(
      'simulated repository failure',
    );
  });
});
