/**
 * Sibling test for `SqliteTodoRepository`: pure in-memory-DB test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteTodoRepository } from '../sqlite-todo-repository.js';
import {
  TODO_RESOLUTION_SEPARATOR,
  TodoResolveRefusedError,
  TodoSupersedeRefusedError,
  type CreateTodoParams,
} from '../todo-repository.js';

function params(overrides: Partial<CreateTodoParams> = {}): CreateTodoParams {
  return {
    id: 'todo-1',
    kind: 'action',
    scope: 'session',
    title: 'Do the thing',
    body: 'body',
    sessionId: 'session-1',
    createdBy: { userId: 'user-1' },
    assigneeUserId: null,
    ...overrides,
  };
}

describe('SqliteTodoRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteTodoRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteTodoRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('create / findById', () => {
    it('stores a human-created item and maps it to the wire shape', async () => {
      const todo = await repository.create(params({ assigneeUserId: 'user-2' }));

      expect(todo).toMatchObject({
        id: 'todo-1',
        kind: 'action',
        scope: 'session',
        title: 'Do the thing',
        body: 'body',
        sessionId: 'session-1',
        createdBy: { userId: 'user-1' },
        assigneeUserId: 'user-2',
        status: 'open',
        resolutionText: null,
        resolvedByUserId: null,
        resolvedAt: null,
      });
      expect(await repository.findById('todo-1')).toEqual(todo);
    });

    it('stores an agent creator as workerId', async () => {
      const todo = await repository.create(params({ createdBy: { workerId: 'worker-1' } }));
      expect(todo.createdBy).toEqual({ workerId: 'worker-1' });
    });

    it('returns null for an unknown id', async () => {
      expect(await repository.findById('missing')).toBeNull();
    });

    it('a second create never overwrites the first', async () => {
      await repository.create(params({ id: 'a', title: 'first' }));
      await repository.create(params({ id: 'b', title: 'second' }));

      expect((await repository.findById('a'))!.title).toBe('first');
      expect((await repository.findById('b'))!.title).toBe('second');
    });

    it('rejects a question with global scope (CHECK) and leaves nothing behind', async () => {
      await expect(repository.create(params({ kind: 'question', scope: 'global' }))).rejects.toThrow();
      expect(await repository.list({})).toEqual([]);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await repository.create(params({ id: 'open-session', sessionId: 'session-1' }));
      await repository.create(params({ id: 'open-global', scope: 'global', sessionId: null, assigneeUserId: 'user-2' }));
      await repository.create(params({ id: 'other-session', sessionId: 'session-2' }));
      await repository.create(params({ id: 'dismissed', sessionId: 'session-1' }));
      await repository.dismiss('dismissed');
    });

    it('returns every item with no filters, and an empty list for an empty table', async () => {
      expect((await repository.list({})).map((t) => t.id).sort()).toEqual(
        ['dismissed', 'open-global', 'open-session', 'other-session'],
      );
      const empty = await createDatabaseForTest();
      expect(await new SqliteTodoRepository(empty).list({})).toEqual([]);
      await empty.destroy();
    });

    it('filters by status, scope, assignee and session', async () => {
      expect((await repository.list({ status: 'dismissed' })).map((t) => t.id)).toEqual(['dismissed']);
      expect((await repository.list({ scope: 'global' })).map((t) => t.id)).toEqual(['open-global']);
      expect((await repository.list({ assigneeUserId: 'user-2' })).map((t) => t.id)).toEqual(['open-global']);
      expect((await repository.list({ sessionId: 'session-1' })).map((t) => t.id).sort()).toEqual(['dismissed', 'open-session']);
      expect(
        (await repository.list({ sessionId: 'session-1', status: 'open' })).map((t) => t.id),
      ).toEqual(['open-session']);
    });
  });

  describe('update', () => {
    it('changes only the given fields of an open item and bumps updatedAt', async () => {
      const created = await repository.create(params());
      await new Promise((r) => setTimeout(r, 5));

      const updated = await repository.update('todo-1', { title: 'New title', assigneeUserId: 'user-2' });

      expect(updated).toMatchObject({ title: 'New title', body: 'body', assigneeUserId: 'user-2' });
      expect(updated!.updatedAt > created.updatedAt).toBe(true);
    });

    it('can clear the assignee with null', async () => {
      await repository.create(params({ assigneeUserId: 'user-2' }));
      expect((await repository.update('todo-1', { assigneeUserId: null }))!.assigneeUserId).toBeNull();
    });

    it('returns null for a missing item and for a non-open item (and does not change it)', async () => {
      expect(await repository.update('missing', { title: 'x' })).toBeNull();

      await repository.create(params());
      await repository.dismiss('todo-1');
      expect(await repository.update('todo-1', { title: 'x' })).toBeNull();
      expect((await repository.findById('todo-1'))!.title).toBe('Do the thing');
    });
  });

  describe('resolve', () => {
    it('marks the item done with the text, resolver and time', async () => {
      await repository.create(params({ kind: 'question' }));

      const resolved = await repository.resolve('todo-1', { text: 'use 3457', resolvedByUserId: 'user-2' });

      expect(resolved).toMatchObject({
        status: 'done',
        resolutionText: 'use 3457',
        resolvedByUserId: 'user-2',
      });
      expect(resolved!.resolvedAt).not.toBeNull();
    });

    it('a second resolution appends after a rule line, moves resolvedAt and keeps status done', async () => {
      await repository.create(params());
      const first = await repository.resolve('todo-1', { text: 'first', resolvedByUserId: 'user-2' });
      await new Promise((r) => setTimeout(r, 5));

      const second = await repository.resolve('todo-1', { text: 'second', resolvedByUserId: 'user-3' });

      expect(second!.status).toBe('done');
      expect(second!.resolutionText).toBe(`first${TODO_RESOLUTION_SEPARATOR}second`);
      expect(second!.resolvedAt! > first!.resolvedAt!).toBe(true);
      expect(second!.resolvedByUserId).toBe('user-3');
    });

    it('an action resolved without text stores no text; a later empty resolve keeps the text', async () => {
      await repository.create(params());
      expect((await repository.resolve('todo-1', { resolvedByUserId: 'u' }))!.resolutionText).toBeNull();

      await repository.resolve('todo-1', { text: 'note', resolvedByUserId: 'u' });
      expect((await repository.resolve('todo-1', { text: '', resolvedByUserId: 'u' }))!.resolutionText).toBe('note');
    });

    it('returns null for a missing item and for a superseded, dismissed or withdrawn item', async () => {
      expect(await repository.resolve('missing', { resolvedByUserId: 'u' })).toBeNull();

      await repository.create(params({ id: 'dismissed' }));
      await repository.dismiss('dismissed');
      await repository.create(params({ id: 'withdrawn', sessionId: 'session-9' }));
      await repository.withdrawOpenSessionScoped('session-9');
      await repository.create(params({ id: 'superseded' }));
      await repository.markSuperseded('superseded', 'session-1');

      for (const id of ['dismissed', 'withdrawn', 'superseded']) {
        expect(await repository.resolve(id, { text: 'x', resolvedByUserId: 'u' })).toBeNull();
      }
      expect((await repository.findById('withdrawn'))!.status).toBe('withdrawn');
    });
  });

  describe('resolve: agent-recorded resolutions', () => {
    it('a human resolve leaves the worker null', async () => {
      await repository.create(params());

      const resolved = await repository.resolve('todo-1', { text: 'done', resolvedByUserId: 'user-2' });

      expect(resolved).toMatchObject({ status: 'done', resolvedByUserId: 'user-2', resolvedByWorkerId: null });
    });

    it('an agent resolve stores the worker and the attributed user', async () => {
      await repository.create(params());

      const resolved = await repository.resolve('todo-1', {
        text: 'ok to merge',
        resolvedByUserId: 'user-2',
        resolvedByWorkerId: 'worker-9',
      });

      expect(resolved).toMatchObject({
        status: 'done',
        resolutionText: 'ok to merge',
        resolvedByUserId: 'user-2',
        resolvedByWorkerId: 'worker-9',
      });
      expect((await repository.findById('todo-1'))!.resolvedByWorkerId).toBe('worker-9');
    });

    it('accepts a null attributed user (a session with no owner) alongside a worker', async () => {
      await repository.create(params());

      const resolved = await repository.resolve('todo-1', { text: 'x', resolvedByUserId: null, resolvedByWorkerId: 'worker-9' });

      expect(resolved).toMatchObject({ resolvedByUserId: null, resolvedByWorkerId: 'worker-9' });
    });

    it('a later human resolve clears the worker: the latest resolver is the record', async () => {
      await repository.create(params());
      await repository.resolve('todo-1', { text: 'quoted', resolvedByUserId: 'user-2', resolvedByWorkerId: 'worker-9' });

      const second = await repository.resolve('todo-1', { text: 'confirmed in the UI', resolvedByUserId: 'user-3' });

      expect(second).toMatchObject({ resolvedByUserId: 'user-3', resolvedByWorkerId: null });
    });

    it('worker id only with done: an item that is not resolvable never gets a worker', async () => {
      await repository.create(params({ id: 'open' }));
      await repository.create(params({ id: 'dismissed' }));
      await repository.dismiss('dismissed');

      expect(
        await repository.resolve('dismissed', { text: 'x', resolvedByUserId: 'u', resolvedByWorkerId: 'worker-9' }),
      ).toBeNull();

      for (const todo of await repository.list({})) {
        expect(todo.resolvedByWorkerId).toBeNull();
        expect(todo.status).not.toBe('done');
      }
    });
  });

  describe('resolveManyOpen', () => {
    const agentParams = (sessionId = 'session-1') => ({
      text: 'all fine to merge',
      resolvedByUserId: 'user-2',
      resolvedByWorkerId: 'worker-9',
      sessionId,
    });

    it('resolves the open items of one session and returns the updated rows', async () => {
      await repository.create(params({ id: 'a' }));
      await repository.create(params({ id: 'b', kind: 'question' }));

      const rows = await repository.resolveManyOpen(['a', 'b'], agentParams());

      expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'done',
          resolutionText: 'all fine to merge',
          resolvedByUserId: 'user-2',
          resolvedByWorkerId: 'worker-9',
        });
        expect(row.resolvedAt).not.toBeNull();
      }
    });

    it('refuses when an id is already done, naming it, and leaves the valid ids open', async () => {
      await repository.create(params({ id: 'a' }));
      await repository.create(params({ id: 'b' }));
      await repository.resolve('b', { text: 'earlier human answer', resolvedByUserId: 'user-3' });

      const error = await repository.resolveManyOpen(['a', 'b'], agentParams()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TodoResolveRefusedError);
      expect((error as TodoResolveRefusedError).refusedIds).toEqual(['b']);
      expect((error as TodoResolveRefusedError).message).toContain('b');
      expect(await repository.findById('a')).toMatchObject({ status: 'open', resolvedByWorkerId: null });
      expect(await repository.findById('b')).toMatchObject({
        resolutionText: 'earlier human answer',
        resolvedByUserId: 'user-3',
        resolvedByWorkerId: null,
      });
    });

    it("refuses another session's, dismissed and unknown ids together and changes nothing", async () => {
      await repository.create(params({ id: 'mine' }));
      await repository.create(params({ id: 'theirs', sessionId: 'session-2' }));
      await repository.create(params({ id: 'gone' }));
      await repository.dismiss('gone');

      const error = await repository
        .resolveManyOpen(['mine', 'theirs', 'gone', 'missing'], agentParams())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TodoResolveRefusedError);
      expect((error as TodoResolveRefusedError).refusedIds.sort()).toEqual(['gone', 'missing', 'theirs']);
      expect((await repository.findById('mine'))!.status).toBe('open');
      expect((await repository.findById('theirs'))!.status).toBe('open');
      expect((await repository.findById('gone'))!.status).toBe('dismissed');
    });

    it('counts a repeated id once', async () => {
      await repository.create(params({ id: 'a' }));

      const rows = await repository.resolveManyOpen(['a', 'a'], agentParams());

      expect(rows.map((r) => r.id)).toEqual(['a']);
    });

    it('re-enters an enclosing transaction: the caller rolling back restores the rows', async () => {
      await repository.create(params({ id: 'a' }));

      await db
        .transaction()
        .execute(async (trx) => {
          const rows = await repository.resolveManyOpen(['a'], agentParams(), trx);
          expect(rows.map((r) => r.id)).toEqual(['a']);
          throw new Error('caller rolls back');
        })
        .catch(() => undefined);

      expect(await repository.findById('a')).toMatchObject({ status: 'open', resolvedByWorkerId: null });
    });

    it('a refusal inside an enclosing transaction throws to the caller without committing the valid ids', async () => {
      await repository.create(params({ id: 'a' }));

      const error = await db
        .transaction()
        .execute((trx) => repository.resolveManyOpen(['a', 'missing'], agentParams(), trx))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TodoResolveRefusedError);
      expect((await repository.findById('a'))!.status).toBe('open');
    });

    it('an empty id list is a no-op: updates nothing and returns an empty list', async () => {
      await repository.create(params({ id: 'a' }));

      const rows = await repository.resolveManyOpen([], agentParams());

      expect(rows).toEqual([]);
      expect((await repository.findById('a'))!.status).toBe('open');
    });
  });

  describe('dismiss / delete', () => {
    it('dismisses only an open item', async () => {
      await repository.create(params());
      expect((await repository.dismiss('todo-1'))!.status).toBe('dismissed');
      expect(await repository.dismiss('todo-1')).toBeNull();
      expect(await repository.dismiss('missing')).toBeNull();
    });

    it('hard-deletes, reporting whether a row was removed', async () => {
      await repository.create(params());
      expect(await repository.delete('todo-1')).toBe(true);
      expect(await repository.findById('todo-1')).toBeNull();
      expect(await repository.delete('todo-1')).toBe(false);
    });
  });

  describe('markSuperseded', () => {
    it('supersedes an open item of the same session only', async () => {
      await repository.create(params());

      expect(await repository.markSuperseded('todo-1', 'session-2')).toBe(false);
      expect((await repository.findById('todo-1'))!.status).toBe('open');

      expect(await repository.markSuperseded('todo-1', 'session-1')).toBe(true);
      expect((await repository.findById('todo-1'))!.status).toBe('superseded');

      expect(await repository.markSuperseded('todo-1', 'session-1')).toBe(false);
    });
  });

  describe('createSuperseding', () => {
    it('writes the new item and supersedes the old one together', async () => {
      await repository.create(params({ id: 'old' }));

      const created = await repository.createSuperseding(params({ id: 'new' }), 'old');

      expect(created.id).toBe('new');
      expect((await repository.findById('old'))!.status).toBe('superseded');
      expect((await repository.findById('new'))!.status).toBe('open');
    });

    it.each([
      ['another session', { id: 'old', sessionId: 'session-2' }],
      ['a non-open item', { id: 'old', sessionId: 'session-1', dismiss: true }],
    ])('refuses to supersede %s and writes nothing', async (_name, old) => {
      await repository.create(params({ id: 'old', sessionId: old.sessionId }));
      if ('dismiss' in old) await repository.dismiss('old');

      await expect(repository.createSuperseding(params({ id: 'new' }), 'old')).rejects.toBeInstanceOf(
        TodoSupersedeRefusedError,
      );
      expect(await repository.findById('new')).toBeNull();
    });

    it('refuses a missing item', async () => {
      await expect(repository.createSuperseding(params({ id: 'new' }), 'missing')).rejects.toBeInstanceOf(
        TodoSupersedeRefusedError,
      );
      expect(await repository.findById('new')).toBeNull();
    });

    it('rolls the supersede back when the insert fails (same transaction)', async () => {
      await repository.create(params({ id: 'old' }));
      await repository.create(params({ id: 'dup' }));

      await expect(repository.createSuperseding(params({ id: 'dup' }), 'old')).rejects.toThrow();

      expect((await repository.findById('old'))!.status).toBe('open');
    });
  });

  describe('withdrawOpenSessionScoped', () => {
    async function seed(): Promise<void> {
      await repository.create(params({ id: 'session-action' }));
      await repository.create(params({ id: 'question', kind: 'question' }));
      await repository.create(params({ id: 'global-action', scope: 'global' }));
      await repository.create(params({ id: 'done' }));
      await repository.resolve('done', { text: 'ok', resolvedByUserId: 'u' });
      await repository.create(params({ id: 'dismissed' }));
      await repository.dismiss('dismissed');
      await repository.create(params({ id: 'other-session', sessionId: 'session-2' }));
    }

    it('withdraws exactly the open session-scoped items of that session and returns the count', async () => {
      await seed();

      expect(await repository.withdrawOpenSessionScoped('session-1')).toBe(2);

      const status = async (id: string) => (await repository.findById(id))!.status;
      expect(await status('session-action')).toBe('withdrawn');
      expect(await status('question')).toBe('withdrawn');
      expect(await status('global-action')).toBe('open');
      expect((await repository.findById('global-action'))!.sessionId).toBe('session-1');
      expect(await status('done')).toBe('done');
      expect(await status('dismissed')).toBe('dismissed');
      expect(await status('other-session')).toBe('open');
    });

    it('is a no-op returning 0 for a session with no items', async () => {
      await seed();
      expect(await repository.withdrawOpenSessionScoped('no-such-session')).toBe(0);
      expect((await repository.list({ status: 'withdrawn' }))).toEqual([]);
    });

    it('commits with the enclosing transaction and rolls back with it', async () => {
      await seed();

      await db.transaction().execute(async (trx) => {
        expect(await repository.withdrawOpenSessionScoped('session-1', trx)).toBe(2);
      });
      expect((await repository.findById('question'))!.status).toBe('withdrawn');

      await repository.create(params({ id: 'later' }));
      await db
        .transaction()
        .execute(async (trx) => {
          await repository.withdrawOpenSessionScoped('session-1', trx);
          throw new Error('abort');
        })
        .catch(() => undefined);
      expect((await repository.findById('later'))!.status).toBe('open');
    });
  });
});
