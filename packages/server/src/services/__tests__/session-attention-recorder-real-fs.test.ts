/**
 * `recordSessionsNeedingAttention`'s boot-wiring cases, split out of
 * `session-attention-recorder.test.ts` because they reopen a real,
 * file-backed `bun:sqlite` database: each test boots a first
 * `createTestContext` against a real on-disk file, closes it, then boots a
 * SECOND context against the SAME file and relies on what the first
 * context wrote actually surviving the close/reopen on real disk. memfs
 * cannot simulate that -- `bun:sqlite`'s file I/O is a native binding, not
 * Node's `fs` module, so it bypasses `mock-fs-helper.ts`'s process-global
 * mock entirely regardless of which process it runs in; what this file
 * actually needs the real filesystem for is `AGENT_CONSOLE_HOME`'s
 * directory (`createTestContext`'s `fsPromises.mkdir(getConfigDir(),
 * ...)`), which DOES go through `fs/promises` and therefore WOULD silently
 * write into an unrelated memfs volume if this ran in the ordinary (first)
 * invocation.
 *
 * This file must never import `mock-fs-helper.ts` (directly or
 * transitively), and it lives in `packages/server`'s second (real-fs)
 * `bun test` invocation (`package.json`), calling `assertRealFs` before
 * any other fs call, per `testing.md`'s real-fs test placement rule.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { sessionAttentionTodoId } from '@agent-console/shared';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { createMockPtyProvider } from '../../__tests__/utils/mock-pty.js';
import { createTestContext, shutdownAppContext, type AppContext } from '../../app-context.js';

const LOCATION_PATH = '/test/location';

async function insertUnreadableSessionRow(ctx: AppContext, id: string, createdBy: string | null = null): Promise<void> {
  await ctx.db
    .insertInto('sessions')
    .values({
      id,
      type: 'quick',
      location_path: LOCATION_PATH,
      server_pid: null,
      initial_prompt: null,
      initial_prompt_delivered: null,
      title: null,
      repository_id: null,
      worktree_id: null,
      paused_at: null,
      parent_session_id: null,
      parent_worker_id: null,
      created_by: createdBy,
      initiated_by: null,
      data_scope: null,
      data_scope_slug: null,
      orphaned_at: null,
      orphaned_reason: null,
    })
    .execute();
  await ctx.db
    .insertInto('workers')
    .values({
      id: `${id}-corrupt-worker`,
      session_id: id,
      type: 'agent',
      name: 'Agent',
      pid: null,
      agent_id: null, // Missing required field for agent -> DataIntegrityError on hydrate.
      base_commit: null,
      embedded_agent_id: null,
      deliver_initial_prompt_on_activation: null,
      sdk_session_id: null,
      model: null,
      reasoning_effort: null,
      context_window_tokens: null,
    })
    .execute();
}

describe('recordSessionsNeedingAttention boot wiring, real disk', () => {
  let appContext: AppContext | null = null;
  let configDir: string | null = null;

  afterEach(async () => {
    if (appContext) {
      await shutdownAppContext(appContext);
      appContext = null;
    }
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
      configDir = null;
    }
  });

  // `bun:sqlite`'s file I/O is a native binding, not Node's `fs` module,
  // so a real tmp path (not a memfs path) is required here -- same
  // reasoning and cleanup pattern as `app-context.test.ts`'s
  // "createTestContext dbPath option" describe.
  function makeTmpDbPath(name: string): string {
    return path.join(
      os.tmpdir(),
      `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
  }

  function removeTmpDbPath(dbPath: string): void {
    Bun.spawnSync(['sh', '-c', `rm -f -- ${dbPath}*`]);
  }

  /**
   * Known, pre-existing limitation (not something this recorder introduced
   * or is expected to fix): `SessionInitializationService.initializeSessions()`'s
   * `saveAll()` call -- which runs on every boot, before
   * `recordSessionsNeedingAttention` ever gets a chance -- persists exactly
   * the session set it iterated via `SessionRepository.findAll()`, which
   * silently SKIPS an unreadable row. Whenever at least one OTHER session
   * also exists, that `saveAll()` call deletes every row not in its own
   * set, including the unreadable row and its worker, as a side effect of
   * restarting -- before any attention item can ever be recorded for it.
   * See Issue #2306 for the root cause and a standalone repro.
   */
  it('a pre-seeded unreadable row does NOT survive a restart when another session exists (known limitation, see #2306)', async () => {
    await assertRealFs('session-attention-recorder-real-fs.test.ts');

    configDir = mkdtempSync(path.join(os.tmpdir(), 'session-attention-recorder-config-'));
    process.env.AGENT_CONSOLE_HOME = configDir;

    const dbPath = makeTmpDbPath('session-attention-recorder-dbpath');
    try {
      const seedContext = await createTestContext({ dbPath, ptyProvider: createMockPtyProvider() });
      // An ordinary, healthy session coexisting with the unreadable row is
      // what triggers the #2306 saveAll() side effect -- this is the
      // realistic-deployment shape, not an empty database.
      await seedContext.sessionManager.createSession({ type: 'quick', locationPath: '/tmp' });

      const user = await seedContext.userRepository.upsertByOsUid(11, 'kate', '/home/kate');
      await insertUnreadableSessionRow(seedContext, 'unreadable-t8', user.id);
      await shutdownAppContext(seedContext);

      appContext = await createTestContext({ dbPath, ptyProvider: createMockPtyProvider() });

      // The unreadable row is gone from `sessions` entirely (direct read,
      // not `findById` -- which hydrates and would reject/behave oddly for
      // a now-corrupt id that no longer exists).
      const row = await appContext.db
        .selectFrom('sessions')
        .where('id', '=', 'unreadable-t8')
        .selectAll()
        .executeTakeFirst();
      expect(row).toBeUndefined();

      // No attention item was ever recorded for it.
      const item = await appContext.todoRepository.findById(sessionAttentionTodoId('unreadable-t8'));
      expect(item).toBeNull();
    } finally {
      removeTmpDbPath(dbPath);
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  /**
   * M6 polarity coverage ("the boot-time `recordSessionsNeedingAttention`
   * call happens at all in `createTestContext`"), using an ORPHANED row
   * instead of an unreadable one: an orphaned row is itself hydratable, so
   * `SessionInitializationService.initializeSessions()` includes it in its
   * own `sessionsToSave` set (it is explicitly preserved, never
   * auto-deleted) and the #2306 saveAll() side effect above does not apply
   * to it. With no other session in the database, a real two-boot cycle
   * must still produce an open attention item for it.
   */
  it('an orphaned row (alone in the database) has an open item after a real restart', async () => {
    await assertRealFs('session-attention-recorder-real-fs.test.ts');

    configDir = mkdtempSync(path.join(os.tmpdir(), 'session-attention-recorder-config-'));
    process.env.AGENT_CONSOLE_HOME = configDir;

    const dbPath = makeTmpDbPath('session-attention-recorder-orphaned-dbpath');
    try {
      const seedContext = await createTestContext({ dbPath, ptyProvider: createMockPtyProvider() });
      const user = await seedContext.userRepository.upsertByOsUid(12, 'liam', '/home/liam');
      await seedContext.sessionRepository.save({
        id: 'orphaned-real-fs',
        type: 'quick',
        locationPath: LOCATION_PATH,
        createdAt: '2026-01-01T00:00:00.000Z',
        workers: [],
        serverPid: null,
        createdBy: user.id,
        recoveryState: 'orphaned',
        orphanedAt: Date.now(),
        orphanedReason: 'worktree-missing',
      });
      await shutdownAppContext(seedContext);

      appContext = await createTestContext({ dbPath, ptyProvider: createMockPtyProvider() });

      const item = await appContext.todoRepository.findById(sessionAttentionTodoId('orphaned-real-fs'));
      expect(item).not.toBeNull();
      expect(item!.status).toBe('open');
    } finally {
      removeTmpDbPath(dbPath);
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });
});
