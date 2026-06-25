/**
 * Tests for resolveSpawnUsername and resolveRequestUsername.
 *
 * Tests the real exported functions directly, not re-implemented logic.
 *
 * `resolveSpawnUsername` resolution paths (always returns a usable string):
 * 1. createdBy is undefined → falls back to os.userInfo().username
 * 2. createdBy is set but user not found in DB → falls back to os.userInfo().username
 * 3. createdBy is set and user found in DB → returns that user's username
 * The "no userRepository" path (userRepository is null) is also tested.
 *
 * `resolveRequestUsername` resolution paths (returns `string | null` so the
 * null can propagate as an explicit "no elevation" signal — the MCP / route
 * variant):
 * (a) createdBy is undefined → null (silent)
 * (b) userRepository is null → null (silent)
 * (c) createdBy is set, user not found in DB → null + structured warn
 *     payload `{ createdBy, ...context }`
 * (d) createdBy is set, user found in DB → user.username (no warn)
 * (e) warn message starts with `${context.toolName}: ` prefix (so log
 *     greps can distinguish callsites)
 */
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import {
  resolveSpawnUsername,
  resolveRequestUsername,
  type ResolveRequestUsernameLogger,
} from '../resolve-spawn-username.js';

/**
 * Recording stub injected via `opts.logger` to assert on warn-call shape.
 * Using DI here -- not `mock.module('../../lib/logger.js', ...)` -- because
 * `mock.module` is process-global in bun:test and other test files
 * (e.g. `worktree-deletion-service.test.ts`) mock the same logger module
 * for silencing, which would clobber the recording stub when the full
 * suite runs. See `.claude/rules/testing.md` Anti-Pattern #2.
 */
function makeRecordingLogger(): {
  logger: ResolveRequestUsernameLogger;
  warnCalls: Array<{ payload: unknown; message: string }>;
} {
  const warnCalls: Array<{ payload: unknown; message: string }> = [];
  const logger: ResolveRequestUsernameLogger = {
    warn: (payload, message) => {
      warnCalls.push({ payload, message });
    },
  };
  return { logger, warnCalls };
}

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

describe('resolveRequestUsername (PR #889 / Issue #886: MCP / route variant)', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('(a) returns null silently when createdBy is undefined', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);
    const { logger, warnCalls } = makeRecordingLogger();

    const result = await resolveRequestUsername(
      undefined,
      userRepository,
      { toolName: 'run_process', sessionId: 'session-1' },
      { logger },
    );

    expect(result).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  it('(b) returns null silently when userRepository is null', async () => {
    const { logger, warnCalls } = makeRecordingLogger();

    const result = await resolveRequestUsername(
      'some-user-id',
      null,
      { toolName: 'run_process', sessionId: 'session-1' },
      { logger },
    );

    expect(result).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  it('(c) returns null and warns with `{ createdBy, ...context }` payload when createdBy is set but user is not in DB', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);
    const { logger, warnCalls } = makeRecordingLogger();

    const result = await resolveRequestUsername(
      'non-existent-user-id',
      userRepository,
      { toolName: 'create_conditional_wakeup', sessionId: 'session-42' },
      { logger },
    );

    expect(result).toBeNull();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].payload).toEqual({
      createdBy: 'non-existent-user-id',
      toolName: 'create_conditional_wakeup',
      sessionId: 'session-42',
    });
  });

  it('(d) returns the DB user username (no warn) when createdBy resolves to a user', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);
    const authUser = await userRepository.upsertByOsUid(7777, 'alice', '/home/alice');
    const { logger, warnCalls } = makeRecordingLogger();

    const result = await resolveRequestUsername(
      authUser.id,
      userRepository,
      { toolName: 'run_process', sessionId: 'session-1' },
      { logger },
    );

    expect(result).toBe('alice');
    expect(warnCalls).toHaveLength(0);
  });

  it('(e) warn message starts with `${toolName}: ` prefix so log greps can distinguish callsites', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);
    const { logger, warnCalls } = makeRecordingLogger();

    // delegate_to_worktree path passes a different context shape
    // (repositoryId, not sessionId). The helper accepts any structured
    // context via `& Record<string, unknown>` and the message template
    // only depends on toolName -- this test pins both contracts.
    await resolveRequestUsername(
      'orphan-uuid',
      userRepository,
      { toolName: 'delegate_to_worktree', repositoryId: 'repo-99' },
      { logger },
    );

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].message).toMatch(/^delegate_to_worktree: /);
    // Full message body is also pinned so a future refactor that drops
    // the post-prefix wording fails this test before reaching the log.
    expect(warnCalls[0].message).toBe(
      'delegate_to_worktree: createdBy does not resolve to a user; running without elevation',
    );
    expect(warnCalls[0].payload).toEqual({
      createdBy: 'orphan-uuid',
      toolName: 'delegate_to_worktree',
      repositoryId: 'repo-99',
    });
  });

  it('(f) production callers that omit `opts.logger` still resolve cleanly (default-logger sanity)', async () => {
    // Pin the "production default path works" sanity: callers that pass
    // no `opts` argument fall through to the module-scope `logger` (Pino).
    // We can't assert the log content here (the real logger is opaque),
    // but we can verify the return value is unaffected.
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);
    const authUser = await userRepository.upsertByOsUid(8888, 'bob', '/home/bob');

    const result = await resolveRequestUsername(
      authUser.id,
      userRepository,
      { toolName: 'run_process', sessionId: 'session-1' },
    );

    expect(result).toBe('bob');
  });
});
