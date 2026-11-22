/**
 * Issue #2295: `recordSessionsNeedingAttention` records one global human
 * TODO item per session needing attention (unreadable or orphaned), and
 * withdraws items whose session no longer needs one. Real SQLite through
 * `createTestContext` (memfs for the filesystem side); no `mock.module()`
 * of the production repositories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import {
  SESSION_ATTENTION_TODO_ID_PREFIX,
  sessionAttentionTodoId,
  SESSION_DELETE_REMOVES,
  SESSION_DELETE_KEEPS,
  SESSION_DELETE_UNRESOLVED_NOTE,
} from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createTestContext, shutdownAppContext, type AppContext } from '../../app-context.js';
import { recordSessionsNeedingAttention, type SessionAttentionRecorderDeps } from '../session-attention-recorder.js';
import type { TodoRepository } from '../../repositories/todo-repository.js';

const TEST_CONFIG_DIR = '/test/config';
const LOCATION_PATH = '/test/location';

function makeDeps(ctx: AppContext, overrides?: Partial<SessionAttentionRecorderDeps>): SessionAttentionRecorderDeps {
  return {
    sessionRepository: ctx.sessionRepository,
    todoRepository: ctx.todoRepository,
    userRepository: ctx.userRepository,
    getRepositoryName: (id: string) => ctx.repositoryManager.getRepository(id)?.name,
    ...overrides,
  };
}

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

function attentionItemsOf(items: { id: string }[]): { id: string }[] {
  return items.filter((i) => i.id.startsWith(SESSION_ATTENTION_TODO_ID_PREFIX));
}

describe('recordSessionsNeedingAttention (Issue #2295)', () => {
  let appContext: AppContext | null = null;

  beforeEach(() => {
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(async () => {
    if (appContext) {
      await shutdownAppContext(appContext);
      appContext = null;
    }
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  it('T4a: an unreadable row gets one open item carrying its reason, id, location and the shared guidance sentences', async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(1, 'alice', '/home/alice');
    const sessionId = 'unreadable-t4a';
    await insertUnreadableSessionRow(appContext, sessionId, user.id);

    await recordSessionsNeedingAttention(makeDeps(appContext));

    const todoId = sessionAttentionTodoId(sessionId);
    const item = await appContext.todoRepository.findById(todoId);
    expect(item).not.toBeNull();
    expect(item!.status).toBe('open');
    expect(item!.scope).toBe('global');
    expect(item!.sessionId).toBe(sessionId);
    expect(item!.createdBy).toEqual({ userId: user.id });
    expect(item!.assigneeUserId).toBe(user.id);

    const body = item!.body;
    expect(body).toContain("The session's stored data cannot be read, so it is not shown in the session list.");
    expect(body).toContain(sessionId);
    expect(body).toContain(LOCATION_PATH);
    for (const sentence of SESSION_DELETE_REMOVES) expect(body).toContain(sentence);
    for (const sentence of SESSION_DELETE_KEEPS) expect(body).toContain(sentence);
    expect(body).toContain(SESSION_DELETE_UNRESOLVED_NOTE);
    expect(body).toContain('There is no delete button for this session yet.');
  });

  it('T4b: an orphaned row gets one item carrying its stored orphanedReason and the orphaned closing sentence', async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(2, 'bob', '/home/bob');
    const sessionId = 'orphaned-t4b';
    await appContext.sessionRepository.save({
      id: sessionId,
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

    await recordSessionsNeedingAttention(makeDeps(appContext));

    const item = await appContext.todoRepository.findById(sessionAttentionTodoId(sessionId));
    expect(item).not.toBeNull();
    const body = item!.body;
    expect(body).toContain('The session is marked Unrecoverable (worktree-missing).');
    expect(body).toContain('To delete it, open the session from the sidebar and press Delete Session.');
  });

  it('T4c: running the pass twice over the same rows still leaves exactly one item each', async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(3, 'carol', '/home/carol');
    const sessionId = 'unreadable-t4c';
    await insertUnreadableSessionRow(appContext, sessionId, user.id);

    const deps = makeDeps(appContext);
    await recordSessionsNeedingAttention(deps);
    await recordSessionsNeedingAttention(deps);

    const openItems = await appContext.todoRepository.list({ status: 'open', scope: 'global' });
    expect(attentionItemsOf(openItems)).toHaveLength(1);
  });

  it('T4d: dismissing the item then re-running the pass leaves it dismissed, with no second item created', async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(4, 'dave', '/home/dave');
    const sessionId = 'unreadable-t4d';
    await insertUnreadableSessionRow(appContext, sessionId, user.id);

    const deps = makeDeps(appContext);
    await recordSessionsNeedingAttention(deps);

    const todoId = sessionAttentionTodoId(sessionId);
    await appContext.todoRepository.dismiss(todoId);

    await recordSessionsNeedingAttention(deps);

    const item = await appContext.todoRepository.findById(todoId);
    expect(item!.status).toBe('dismissed');

    const all = await appContext.todoRepository.list({});
    expect(attentionItemsOf(all)).toHaveLength(1);
  });

  it('T4e: deleting the row directly withdraws its previously-open item', async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(5, 'erin', '/home/erin');
    const sessionId = 'unreadable-t4e';
    await insertUnreadableSessionRow(appContext, sessionId, user.id);

    const deps = makeDeps(appContext);
    await recordSessionsNeedingAttention(deps);

    const todoId = sessionAttentionTodoId(sessionId);
    expect((await appContext.todoRepository.findById(todoId))!.status).toBe('open');

    await appContext.db.deleteFrom('sessions').where('id', '=', sessionId).execute();

    await recordSessionsNeedingAttention(deps);

    expect((await appContext.todoRepository.findById(todoId))!.status).toBe('withdrawn');
  });

  it('T4f: an orphaned row set back to healthy withdraws its previously-open item', async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(6, 'frank', '/home/frank');
    const sessionId = 'orphaned-t4f';
    await appContext.sessionRepository.save({
      id: sessionId,
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

    const deps = makeDeps(appContext);
    await recordSessionsNeedingAttention(deps);

    const todoId = sessionAttentionTodoId(sessionId);
    expect((await appContext.todoRepository.findById(todoId))!.status).toBe('open');

    await appContext.sessionRepository.update(sessionId, { recoveryState: 'healthy' });

    await recordSessionsNeedingAttention(deps);

    expect((await appContext.todoRepository.findById(todoId))!.status).toBe('withdrawn');
  });

  it('T4g: only healthy rows, and an empty sessions table, create no item either way', async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(7, 'grace', '/home/grace');

    const deps = makeDeps(appContext);

    // Empty table.
    await recordSessionsNeedingAttention(deps);
    expect(attentionItemsOf(await appContext.todoRepository.list({}))).toHaveLength(0);

    // Only healthy rows.
    await appContext.sessionRepository.save({
      id: 'healthy-t4g',
      type: 'quick',
      locationPath: LOCATION_PATH,
      createdAt: '2026-01-01T00:00:00.000Z',
      workers: [],
      serverPid: null,
      createdBy: user.id,
    });
    await recordSessionsNeedingAttention(deps);
    expect(attentionItemsOf(await appContext.todoRepository.list({}))).toHaveLength(0);
  });

  it('T4h: created_by NULL resolves to the sole user, or to nobody when there are two', async () => {
    appContext = await createTestContext();

    // `createTestContext` itself upserts a "server process" user at boot
    // (`SingleUserMode.create`), so right after construction there is
    // already exactly one user -- that boot user IS the sole user this
    // case tests against, not a second one created here.
    const bootUsers = await appContext.userRepository.findAll();
    expect(bootUsers).toHaveLength(1);
    const soleUser = bootUsers[0];

    const sessionId = 'unreadable-t4h-one-user';
    await insertUnreadableSessionRow(appContext, sessionId, null);

    const deps = makeDeps(appContext);
    await recordSessionsNeedingAttention(deps);

    const item = await appContext.todoRepository.findById(sessionAttentionTodoId(sessionId));
    expect(item).not.toBeNull();
    expect(item!.createdBy).toEqual({ userId: soleUser.id });
    expect(item!.assigneeUserId).toBeNull();

    // A second user makes the creator ambiguous for the next unreadable row.
    await appContext.userRepository.upsertByOsUid(9, 'ivy', '/home/ivy');
    const sessionId2 = 'unreadable-t4h-two-users';
    await insertUnreadableSessionRow(appContext, sessionId2, null);

    await recordSessionsNeedingAttention(deps);

    expect(await appContext.todoRepository.findById(sessionAttentionTodoId(sessionId2))).toBeNull();
  });

  it("T4i: one row's create() failure never stops the other row's item from being created, and the pass does not throw", async () => {
    appContext = await createTestContext();
    const user = await appContext.userRepository.upsertByOsUid(10, 'jack', '/home/jack');

    const failingId = 'unreadable-t4i-fails';
    const okId = 'unreadable-t4i-ok';
    await insertUnreadableSessionRow(appContext, failingId, user.id);
    await insertUnreadableSessionRow(appContext, okId, user.id);

    const realTodoRepository = appContext.todoRepository;
    const failingTodoId = sessionAttentionTodoId(failingId);
    // A plain object spread of `realTodoRepository` would copy nothing --
    // its methods live on the class prototype, not as own properties -- so
    // a Proxy is used to override only `create` while every other method
    // still dispatches to the real instance.
    const wrapped: TodoRepository = new Proxy(realTodoRepository, {
      get(target, prop, receiver) {
        if (prop === 'create') {
          return async (params: Parameters<TodoRepository['create']>[0], executor?: Parameters<TodoRepository['create']>[1]) => {
            if (params.id === failingTodoId) throw new Error('simulated create failure');
            return target.create(params, executor);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(recordSessionsNeedingAttention(makeDeps(appContext, { todoRepository: wrapped }))).resolves.toBeUndefined();

    expect(await appContext.todoRepository.findById(failingTodoId)).toBeNull();
    expect(await appContext.todoRepository.findById(sessionAttentionTodoId(okId))).not.toBeNull();
  });

  describe('T8: boot wiring', () => {
    // `bun:sqlite`'s file I/O is a native binding, not Node's `fs` module,
    // so a real tmp path (not a memfs path) is required here -- same
    // reasoning and cleanup pattern as
    // `app-context.test.ts`'s "createTestContext dbPath option" describe.
    function makeTmpDbPath(): string {
      return path.join(
        os.tmpdir(),
        `session-attention-recorder-dbpath-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
      );
    }

    function removeTmpDbPath(dbPath: string): void {
      Bun.spawnSync(['sh', '-c', `rm -f -- ${dbPath}*`]);
    }

    it('a pre-seeded unreadable row has an open item right after construction', async () => {
      // Build a first context to get a dbPath on disk, pre-seed an
      // unreadable row directly, close it, then boot a SECOND context
      // against the same file: the recorder's call inside
      // createTestContext must run against this pre-existing row before
      // the function even returns.
      const dbPath = makeTmpDbPath();
      try {
        const seedContext = await createTestContext({ dbPath });
        const user = await seedContext.userRepository.upsertByOsUid(11, 'kate', '/home/kate');
        await insertUnreadableSessionRow(seedContext, 'unreadable-t8', user.id);
        await shutdownAppContext(seedContext);

        appContext = await createTestContext({ dbPath });

        const item = await appContext.todoRepository.findById(sessionAttentionTodoId('unreadable-t8'));
        expect(item).not.toBeNull();
        expect(item!.status).toBe('open');
      } finally {
        removeTmpDbPath(dbPath);
      }
    });
  });
});
