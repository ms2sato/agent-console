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
  type AddTodoMoveParams,
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

  describe('list: visibleTo (the default human view)', () => {
    // Each of the three OR branches is reached by a user that matches only that branch.
    beforeEach(async () => {
      await repository.create(params({ id: 'assigned', sessionId: 'other', createdBy: { userId: 'user-9' }, assigneeUserId: 'assignee-u' }));
      await repository.create(params({ id: 'created', sessionId: 'other', createdBy: { userId: 'creator-u' } }));
      await repository.create(params({ id: 'in-session', sessionId: 'shared-1', createdBy: { userId: 'user-9' } }));
      await repository.create(params({ id: 'hidden', sessionId: 'other', createdBy: { workerId: 'worker-1' }, assigneeUserId: 'user-2' }));
    });

    const ids = async (filters: Parameters<SqliteTodoRepository['list']>[0]) =>
      (await repository.list(filters)).map((t) => t.id).sort();

    it('the assignee branch alone: an item assigned to the user', async () => {
      expect(await ids({ visibleTo: { userId: 'assignee-u', sessionIds: [] } })).toEqual(['assigned']);
    });

    it('the creator branch alone: an item the user created', async () => {
      expect(await ids({ visibleTo: { userId: 'creator-u', sessionIds: [] } })).toEqual(['created']);
    });

    it('the session branch alone: an item of one of the listed sessions', async () => {
      expect(await ids({ visibleTo: { userId: 'nobody', sessionIds: ['shared-1'] } })).toEqual(['in-session']);
    });

    it('an empty sessionIds list is valid (no IN () clause) and still returns the assigned and created items', async () => {
      expect(await ids({ visibleTo: { userId: 'assignee-u', sessionIds: [] } })).toEqual(['assigned']);
      expect(await ids({ visibleTo: { userId: 'nobody', sessionIds: [] } })).toEqual([]);
    });

    it('the three branches union, and an item matching none stays out', async () => {
      expect(await ids({ visibleTo: { userId: 'assignee-u', sessionIds: ['shared-1'] } })).toEqual(['assigned', 'in-session']);
    });

    it('composes (AND) with the other filters', async () => {
      await repository.dismiss('in-session');
      const visibleTo = { userId: 'assignee-u', sessionIds: ['shared-1'] };
      expect(await ids({ visibleTo, status: 'dismissed' })).toEqual(['in-session']);
      expect(await ids({ visibleTo, status: 'open' })).toEqual(['assigned']);
    });
  });

  describe('adopt', () => {
    it('workerId null on a human-created item leaves created_worker_id NULL and the creator the human', async () => {
      await repository.create(params({ createdBy: { userId: 'user-1' } }));

      const adopted = await repository.adopt('todo-1', { sessionId: 'session-2', workerId: null, actor: { userId: 'user-3' }, expectedSessionId: 'session-1' });

      expect(adopted).toMatchObject({ sessionId: 'session-2', createdBy: { userId: 'user-1' } });
      const row = await db.selectFrom('todos').select(['created_worker_id', 'created_user_id']).where('id', '=', 'todo-1').executeTakeFirstOrThrow();
      expect(row).toEqual({ created_worker_id: null, created_user_id: 'user-1' });
    });

    it('moves session_id and created_worker_id of an agent-created open item and bumps updatedAt', async () => {
      const created = await repository.create(
        params({ scope: 'global', sessionId: 'session-1', createdBy: { workerId: 'worker-1' } }),
      );
      await new Promise((r) => setTimeout(r, 5));

      const adopted = await repository.adopt('todo-1', { sessionId: 'session-2', workerId: 'worker-2', actor: { workerId: 'worker-2' }, expectedSessionId: 'session-1' });

      expect(adopted).toMatchObject({
        sessionId: 'session-2',
        createdBy: { workerId: 'worker-2' },
        scope: 'global',
        status: 'open',
        title: 'Do the thing',
      });
      expect(adopted!.updatedAt > created.updatedAt).toBe(true);
      expect(await repository.findById('todo-1')).toEqual(adopted);
    });

    it('moves only session_id of a human-created item: its creator stays the human and no worker is set', async () => {
      await repository.create(params({ createdBy: { userId: 'user-1' } }));

      const adopted = await repository.adopt('todo-1', { sessionId: 'session-2', workerId: 'worker-2', actor: { workerId: 'worker-2' }, expectedSessionId: 'session-1' });

      expect(adopted).toMatchObject({ sessionId: 'session-2', createdBy: { userId: 'user-1' } });
      expect(adopted!.createdBy).not.toHaveProperty('workerId');
    });

    it('a stale expectedSessionId (the item moved since it was read) returns null and leaves the row untouched', async () => {
      await repository.create(params({ scope: 'global', sessionId: 'session-1', createdBy: { workerId: 'worker-1' } }));
      const before = await repository.findById('todo-1');

      const adopted = await repository.adopt('todo-1', { sessionId: 'session-3', workerId: 'worker-3', actor: { workerId: 'worker-3' }, expectedSessionId: 'session-2' });

      expect(adopted).toBeNull();
      expect(await repository.findById('todo-1')).toEqual(before);
    });

    it('a stale NULL expectedSessionId (the item has a session now) returns null and leaves the row untouched', async () => {
      await repository.create(params({ scope: 'global', sessionId: 'session-1', createdBy: { userId: 'user-1' } }));
      const before = await repository.findById('todo-1');

      const adopted = await repository.adopt('todo-1', { sessionId: 'session-3', workerId: 'worker-3', actor: { workerId: 'worker-3' }, expectedSessionId: null });

      expect(adopted).toBeNull();
      expect(await repository.findById('todo-1')).toEqual(before);
    });

    it('an item with no session is adopted when NULL is expected, and refused when a session is expected', async () => {
      await repository.create(params({ scope: 'global', sessionId: null, createdBy: { userId: 'user-1' } }));

      expect(await repository.adopt('todo-1', { sessionId: 'session-3', workerId: 'worker-3', actor: { workerId: 'worker-3' }, expectedSessionId: 'session-1' })).toBeNull();
      const adopted = await repository.adopt('todo-1', { sessionId: 'session-3', workerId: 'worker-3', actor: { workerId: 'worker-3' }, expectedSessionId: null });

      expect(adopted).toMatchObject({ sessionId: 'session-3', createdBy: { userId: 'user-1' } });
    });

    it('returns null for an unknown id and for every non-open status, leaving the row untouched', async () => {
      expect(await repository.adopt('missing', { sessionId: 'session-2', workerId: 'worker-2', actor: { workerId: 'worker-2' }, expectedSessionId: 'session-1' })).toBeNull();

      for (const [id, close] of [
        ['done', () => repository.resolve('done', { text: 'ok', resolvedByUserId: 'user-1' })],
        ['dismissed', () => repository.dismiss('dismissed')],
        ['superseded', () => repository.markSuperseded('superseded', 'session-1')],
      ] as const) {
        await repository.create(params({ id, createdBy: { workerId: 'worker-1' } }));
        await close();
        const before = await repository.findById(id);

        expect(await repository.adopt(id, { sessionId: 'session-2', workerId: 'worker-2', actor: { workerId: 'worker-2' }, expectedSessionId: 'session-1' })).toBeNull();
        expect(await repository.findById(id)).toEqual(before);
      }
    });
  });

  describe('adopt: the move row', () => {
    const adoptParams = (overrides: Record<string, unknown> = {}) => ({
      sessionId: 'session-2',
      workerId: 'worker-2',
      actor: { workerId: 'worker-2' },
      expectedSessionId: 'session-1' as string | null,
      ...overrides,
    });

    it('writes one move row with the previous session as from and the new one as to, and no statement by default', async () => {
      await repository.create(params({ createdBy: { workerId: 'worker-1' } }));

      await repository.adopt('todo-1', adoptParams());

      const activities = await repository.listActivities('todo-1');
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        kind: 'moved',
        todoId: 'todo-1',
        actor: { workerId: 'worker-2' },
        fromSessionId: 'session-1',
        toSessionId: 'session-2',
        statement: null,
        attributedUserId: null,
      });
    });

    it('records the statement and the attributed user', async () => {
      await repository.create(params());

      await repository.adopt('todo-1', adoptParams({ statement: 'take it over, please', statedBy: 'user-9' }));

      expect((await repository.listActivities('todo-1'))[0]).toMatchObject({
        kind: 'moved',
        statement: 'take it over, please',
        attributedUserId: 'user-9',
      });
    });

    it('a statement without an attributed user is stored unattributed', async () => {
      await repository.create(params());

      await repository.adopt('todo-1', adoptParams({ statement: 'take it over' }));

      expect((await repository.listActivities('todo-1'))[0]).toMatchObject({ statement: 'take it over', attributedUserId: null });
    });

    it('a human actor is recorded as {userId}', async () => {
      await repository.create(params());

      await repository.adopt('todo-1', adoptParams({ actor: { userId: 'user-3' } }));

      expect((await repository.listActivities('todo-1'))[0]).toMatchObject({ actor: { userId: 'user-3' } });
    });

    it('from is null for an item that had no session', async () => {
      await repository.create(params({ scope: 'global', sessionId: null }));

      await repository.adopt('todo-1', adoptParams({ expectedSessionId: null }));

      expect((await repository.listActivities('todo-1'))[0]).toMatchObject({ fromSessionId: null, toSessionId: 'session-2' });
    });

    it('a refused adopt (stale session, non-open item, unknown id) writes no move row', async () => {
      await repository.create(params({ id: 'stale' }));
      await repository.create(params({ id: 'closed' }));
      await repository.dismiss('closed');

      expect(await repository.adopt('stale', adoptParams({ expectedSessionId: 'session-9' }))).toBeNull();
      expect(await repository.adopt('closed', adoptParams())).toBeNull();
      expect(await repository.adopt('missing', adoptParams())).toBeNull();

      expect(await db.selectFrom('todo_moves').selectAll().execute()).toEqual([]);
    });

    it('a re-adopt into the session the item is already in writes no move row (no session change to record)', async () => {
      await repository.create(params({ createdBy: { workerId: 'worker-1' } }));

      const again = await repository.adopt('todo-1', adoptParams({ sessionId: 'session-1', expectedSessionId: 'session-1' }));

      expect(again).toMatchObject({ sessionId: 'session-1', createdBy: { workerId: 'worker-2' } });
      expect(await db.selectFrom('todo_moves').selectAll().execute()).toEqual([]);
    });

    // Atomicity. Reach (measured): running the update outside any transaction (the call without an
    // enclosing executor going through `run(this.db)` instead of `.transaction().execute(run)`)
    // fails this test and no other. The move insert is made to fail by a CHECK
    // (`todo_moves_attribution_check`: an attributed user needs a statement), after the
    // todos update has already run.
    it('a failing move insert rolls the todos update back: the item stays where it was', async () => {
      await repository.create(params({ createdBy: { workerId: 'worker-1' } }));
      const before = await repository.findById('todo-1');

      await expect(repository.adopt('todo-1', adoptParams({ statedBy: 'user-9' }))).rejects.toThrow(/todo_moves_attribution_check/);

      expect(await repository.findById('todo-1')).toEqual(before);
      expect(await db.selectFrom('todo_moves').selectAll().execute()).toEqual([]);
    });

    it('joins the caller\'s transaction: the update and the move row roll back with it', async () => {
      await repository.create(params({ createdBy: { workerId: 'worker-1' } }));
      const before = await repository.findById('todo-1');

      await db
        .transaction()
        .execute(async (trx) => {
          expect(await repository.adopt('todo-1', adoptParams(), trx)).not.toBeNull();
          throw new Error('abort');
        })
        .catch(() => undefined);

      expect(await repository.findById('todo-1')).toEqual(before);
      expect(await db.selectFrom('todo_moves').selectAll().execute()).toEqual([]);
    });
  });

  describe('comments and commentCount', () => {
    it('addComment returns the comment variant and stores it', async () => {
      await repository.create(params());

      const comment = await repository.addComment({ todoId: 'todo-1', actor: { userId: 'user-2' }, text: 'Which environment?' });

      expect(comment).toMatchObject({ kind: 'comment', todoId: 'todo-1', actor: { userId: 'user-2' }, text: 'Which environment?' });
      expect(comment!.id.length).toBeGreaterThan(0);
      expect(await repository.listActivities('todo-1')).toEqual([comment!]);
    });

    it('a new item has commentCount 0; each comment adds one, in findById and in list', async () => {
      await repository.create(params());
      expect((await repository.findById('todo-1'))!.commentCount).toBe(0);

      await repository.addComment({ todoId: 'todo-1', actor: { userId: 'user-2' }, text: 'one' });
      await repository.addComment({ todoId: 'todo-1', actor: { workerId: 'worker-1' }, text: 'two' });

      expect((await repository.findById('todo-1'))!.commentCount).toBe(2);
      expect((await repository.list({}))[0]!.commentCount).toBe(2);
    });

    // Reach: by structure, not by a filter. The count is a subquery over `todo_comments`
    // alone and a move lives in another table, so there is no `kind = 'comment'` predicate
    // whose removal could make this fail; this pin records the contract (moves never
    // count) rather than guarding a mutable line.
    it('commentCount ignores moves', async () => {
      await repository.create(params());
      await repository.addMove(moveParams());
      await repository.addMove(moveParams({ toSessionId: 'session-3' }));
      await repository.addComment({ todoId: 'todo-1', actor: { userId: 'user-2' }, text: 'one' });

      expect((await repository.findById('todo-1'))!.commentCount).toBe(1);
    });

    // Reach (m9, measured): dropping the correlation (`todo_comments.todo_id = todos.id`) from the
    // count subquery fails this test and 'every write that returns an item carries its commentCount'.
    it('list counts each item\'s own comments (the subquery is correlated to the row)', async () => {
      await repository.create(params({ id: 'a' }));
      await repository.create(params({ id: 'b' }));
      await repository.create(params({ id: 'c' }));
      await repository.addComment({ todoId: 'a', actor: { userId: 'u' }, text: '1' });
      await repository.addComment({ todoId: 'a', actor: { userId: 'u' }, text: '2' });
      await repository.addComment({ todoId: 'b', actor: { userId: 'u' }, text: '3' });

      const counts = Object.fromEntries((await repository.list({})).map((t) => [t.id, t.commentCount]));
      expect(counts).toEqual({ a: 2, b: 1, c: 0 });
    });

    it('every write that returns an item carries its commentCount (resolve, dismiss, update, adopt, resolveManyOpen)', async () => {
      for (const id of ['r', 'd', 'u', 'ad', 'many']) {
        await repository.create(params({ id, createdBy: { workerId: 'worker-1' } }));
        await repository.addComment({ todoId: id, actor: { userId: 'u' }, text: 'x' });
      }

      expect((await repository.resolve('r', { text: 'ok', resolvedByUserId: 'u' }))!.commentCount).toBe(1);
      expect((await repository.dismiss('d'))!.commentCount).toBe(1);
      expect((await repository.update('u', { title: 'new' }))!.commentCount).toBe(1);
      expect(
        (await repository.adopt('ad', { sessionId: 's2', workerId: 'w2', actor: { workerId: 'w2' }, expectedSessionId: 'session-1' }))!.commentCount,
      ).toBe(1);
      const many = await repository.resolveManyOpen(['many'], { text: 'ok', resolvedByUserId: 'u', sessionId: 'session-1' });
      expect(many[0]!.commentCount).toBe(1);
    });

    // Reach (measured): reverting `addComment` to a plain INSERT fails the three tests below (the
    // unknown item throws a FOREIGN KEY error instead of returning null; closed items get a row).
    it('addComment on an unknown item returns null and writes nothing', async () => {
      expect(await repository.addComment({ todoId: 'missing', actor: { userId: 'u' }, text: 'x' })).toBeNull();
      expect(await db.selectFrom('todo_comments').selectAll().execute()).toEqual([]);
    });

    it.each(['dismissed', 'superseded', 'withdrawn'] as const)('addComment on a %s item returns null and writes nothing', async (status) => {
      await repository.create(params());
      if (status === 'dismissed') await repository.dismiss('todo-1');
      if (status === 'superseded') await repository.markSuperseded('todo-1', 'session-1');
      if (status === 'withdrawn') await repository.withdrawOpenSessionScoped('session-1');

      expect(await repository.addComment({ todoId: 'todo-1', actor: { userId: 'u' }, text: 'x' })).toBeNull();
      expect(await db.selectFrom('todo_comments').selectAll().execute()).toEqual([]);
    });

    it('addComment on a done item succeeds (the item stays done)', async () => {
      await repository.create(params());
      await repository.resolve('todo-1', { text: 'ok', resolvedByUserId: 'u' });

      const comment = await repository.addComment({ todoId: 'todo-1', actor: { userId: 'u' }, text: 'after' });

      expect(comment).toMatchObject({ kind: 'comment', text: 'after' });
      expect((await repository.findById('todo-1'))!.status).toBe('done');
    });
  });

  function moveParams(overrides: Partial<AddTodoMoveParams> = {}): AddTodoMoveParams {
    return {
      todoId: 'todo-1',
      actor: { workerId: 'worker-2' },
      fromSessionId: 'session-1',
      toSessionId: 'session-2',
      statement: null,
      attributedUserId: null,
      ...overrides,
    };
  }

  describe('listActivities', () => {
    const T0 = '2026-10-17T00:00:00.000Z';
    const T1 = '2026-10-17T01:00:00.000Z';
    const T2 = '2026-10-17T02:00:00.000Z';

    async function insertCommentRow(id: string, createdAt: string, todoId = 'todo-1'): Promise<void> {
      await db
        .insertInto('todo_comments')
        .values({ id, todo_id: todoId, actor_user_id: 'u', actor_worker_id: null, text: `text ${id}`, created_at: createdAt })
        .execute();
    }

    async function insertMoveRow(id: string, createdAt: string, todoId = 'todo-1'): Promise<void> {
      await db
        .insertInto('todo_moves')
        .values({
          id,
          todo_id: todoId,
          actor_user_id: null,
          actor_worker_id: 'w',
          from_session_id: 'session-1',
          to_session_id: 'session-2',
          statement: `statement ${id}`,
          attributed_user_id: null,
          created_at: createdAt,
        })
        .execute();
    }

    // The rows are inserted DIRECTLY: the repository API stamps `new Date()` and the tie needs
    // identical `created_at`. Natural UNION ALL output is "all comments, then all moves" in
    // insertion order, so the inversions below are what make each mutation observable:
    //   case 1 puts the MOVE's id ('a') before the comment's ('b'), so ordering by id alone
    //     yields [move, comment];
    //   case 2 inserts the later id ('d') first, so insertion order yields [d, c];
    //   case 3 inserts the earliest row last.
    // Reach, each mutation applied alone to the ORDER BY of the batched builder that `listActivities`
    // delegates to (re-measured after the move to `listActivitiesForTodos`; tests that fail):
    //   m7a drop .orderBy('kind')       -> this test; 'listActivitiesForTodos > applies the same tie-break ...'
    //   m7b drop .orderBy('id')         -> this test; 'listActivitiesForTodos > applies the same tie-break ...'
    //   m7c drop .orderBy('created_at') -> this test; 'listActivities > lists what the write methods stored ...';
    //                                      'listActivitiesForTodos > gives each item its own thread in order ...'
    //   drop the leading .orderBy('todo_id') -> NO test fails: rows are grouped through a Map, so the
    //     leading key only makes the whole result deterministic; per-item order does not depend on it.
    it('orders by created_at, then kind (comment before moved), then id', async () => {
      await repository.create(params());
      await insertMoveRow('a', T1);
      await insertCommentRow('b', T1);
      await insertCommentRow('d', T2);
      await insertCommentRow('c', T2);
      await insertCommentRow('e', T0);

      const activities = await repository.listActivities('todo-1');

      expect(activities.map((a) => `${a.kind}:${a.id}`)).toEqual(['comment:e', 'comment:b', 'moved:a', 'comment:c', 'comment:d']);
    });

    // Reach (m8, re-measured against the batched builder): swapping `text` and `statement` in branch B's
    // column list fails this test, 'lists what the write methods stored ...', and the two adopt tests that
    // record a statement ('records the statement and the attributed user', 'a statement without an attributed
    // user is stored unattributed'): the positional UNION pairs B's statement with A's `text` column.
    it('maps each branch into its variant', async () => {
      await repository.create(params());
      await insertCommentRow('c1', T0);
      await insertMoveRow('m1', T1);

      const [comment, move] = await repository.listActivities('todo-1');

      expect(comment).toEqual({
        id: 'c1',
        todoId: 'todo-1',
        kind: 'comment',
        actor: { userId: 'u' },
        text: 'text c1',
        createdAt: T0,
      });
      expect(comment).not.toHaveProperty('toSessionId');
      expect(move).toEqual({
        id: 'm1',
        todoId: 'todo-1',
        kind: 'moved',
        actor: { workerId: 'w' },
        fromSessionId: 'session-1',
        toSessionId: 'session-2',
        statement: 'statement m1',
        attributedUserId: null,
        createdAt: T1,
      });
      expect(move).not.toHaveProperty('text');
    });

    it('returns only the given item\'s activities, and [] for an item with none or an unknown id', async () => {
      await repository.create(params({ id: 'todo-1' }));
      await repository.create(params({ id: 'todo-2' }));
      await insertCommentRow('c-own', T0, 'todo-1');
      await insertMoveRow('m-own', T1, 'todo-1');
      await insertCommentRow('c-other', T0, 'todo-2');
      await insertMoveRow('m-other', T1, 'todo-2');
      await repository.create(params({ id: 'todo-3' }));

      expect((await repository.listActivities('todo-1')).map((a) => a.id)).toEqual(['c-own', 'm-own']);
      expect(await repository.listActivities('todo-3')).toEqual([]);
      expect(await repository.listActivities('missing')).toEqual([]);
    });

    it('lists what the write methods stored, in the order written', async () => {
      await repository.create(params());
      const first = await repository.addComment({ todoId: 'todo-1', actor: { userId: 'u' }, text: 'first' });
      await new Promise((r) => setTimeout(r, 5));
      const second = await repository.addMove(moveParams({ statement: 'go', attributedUserId: 'user-9' }));
      await new Promise((r) => setTimeout(r, 5));
      const third = await repository.addComment({ todoId: 'todo-1', actor: { workerId: 'worker-1' }, text: 'third' });

      expect(await repository.listActivities('todo-1')).toEqual([first!, second, third!]);
      expect(second).toMatchObject({ kind: 'moved', statement: 'go', attributedUserId: 'user-9', toSessionId: 'session-2' });
    });
  });

  describe('listActivitiesForTodos', () => {
    const T = (n: number) => `2026-10-17T0${n}:00:00.000Z`;

    async function commentRow(id: string, todoId: string, createdAt: string): Promise<void> {
      await db
        .insertInto('todo_comments')
        .values({ id, todo_id: todoId, actor_user_id: 'u', actor_worker_id: null, text: `text ${id}`, created_at: createdAt })
        .execute();
    }
    async function moveRow(id: string, todoId: string, createdAt: string): Promise<void> {
      await db
        .insertInto('todo_moves')
        .values({
          id,
          todo_id: todoId,
          actor_user_id: null,
          actor_worker_id: 'w',
          from_session_id: 'session-1',
          to_session_id: 'session-2',
          statement: null,
          attributed_user_id: null,
          created_at: createdAt,
        })
        .execute();
    }

    // Three items with interleaved activities, inserted in a scrambled order: each item must come
    // back with ONLY its own rows, in (created_at, kind, id) order.
    // Reach (measured against this builder): dropping `created_at` from the ORDER BY fails this test.
    it('gives each item its own thread in order, from one statement', async () => {
      for (const id of ['a', 'b', 'c']) await repository.create(params({ id }));
      await commentRow('c3', 'c', T(3));
      await commentRow('a2', 'a', T(2));
      await moveRow('b1', 'b', T(1));
      await commentRow('a1', 'a', T(1));
      await moveRow('a3', 'a', T(3));
      await commentRow('b2', 'b', T(2));
      await commentRow('c1', 'c', T(1));

      const byTodo = await repository.listActivitiesForTodos(['c', 'a', 'b']);

      expect([...byTodo.keys()].sort()).toEqual(['a', 'b', 'c']);
      expect(byTodo.get('a')!.map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
      expect(byTodo.get('b')!.map((x) => x.id)).toEqual(['b1', 'b2']);
      expect(byTodo.get('c')!.map((x) => x.id)).toEqual(['c1', 'c3']);
      for (const [todoId, thread] of byTodo) expect(thread.every((x) => x.todoId === todoId)).toBe(true);
    });

    it('applies the same tie-break as listActivities (created_at, then kind, then id) inside each thread', async () => {
      await repository.create(params({ id: 'a' }));
      await repository.create(params({ id: 'b' }));
      await moveRow('m', 'a', T(1));
      await commentRow('z', 'a', T(1));
      await commentRow('y', 'a', T(1));
      await commentRow('q', 'b', T(1));

      const byTodo = await repository.listActivitiesForTodos(['a', 'b']);

      expect(byTodo.get('a')!.map((x) => `${x.kind}:${x.id}`)).toEqual(['comment:y', 'comment:z', 'moved:m']);
      expect(byTodo.get('a')).toEqual(await repository.listActivities('a'));
    });

    it('an item with no activity maps to an empty list; an unknown id too; duplicates are read once', async () => {
      await repository.create(params({ id: 'a' }));
      await repository.create(params({ id: 'bare' }));
      await commentRow('a1', 'a', T(1));

      const byTodo = await repository.listActivitiesForTodos(['a', 'bare', 'ghost', 'a']);

      expect([...byTodo.keys()].sort()).toEqual(['a', 'bare', 'ghost']);
      expect(byTodo.get('a')!.map((x) => x.id)).toEqual(['a1']);
      expect(byTodo.get('bare')).toEqual([]);
      expect(byTodo.get('ghost')).toEqual([]);
    });

    it('reads more ids than one chunk (501) and groups them all', async () => {
      const ids = Array.from({ length: 501 }, (_, i) => `t${i}`);
      for (const id of ids) await repository.create(params({ id }));
      await commentRow('first', 't0', T(1));
      await commentRow('last', 't500', T(1));

      const byTodo = await repository.listActivitiesForTodos(ids);

      expect(byTodo.size).toBe(501);
      expect(byTodo.get('t0')!.map((x) => x.id)).toEqual(['first']);
      expect(byTodo.get('t500')!.map((x) => x.id)).toEqual(['last']);
    });

    // Boundary: an empty list is an empty Map and issues NO statement at all.
    it('an empty list returns an empty Map without touching the database', async () => {
      let statements = 0;
      const counting = db.withPlugin({
        transformQuery: (args) => args.node,
        // Once per EXECUTED statement (transformQuery also runs for nested sub-builders).
        transformResult: async (args) => {
          statements += 1;
          return args.result;
        },
      });

      const empty = await new SqliteTodoRepository(counting).listActivitiesForTodos([]);

      expect(empty.size).toBe(0);
      expect(statements).toBe(0);
    });

    it('a non-empty list is exactly one statement (not one per item), and listActivities is one too', async () => {
      for (const id of ['a', 'b', 'c']) await repository.create(params({ id }));
      let statements = 0;
      const counting = db.withPlugin({
        transformQuery: (args) => args.node,
        // Once per EXECUTED statement (transformQuery also runs for nested sub-builders).
        transformResult: async (args) => {
          statements += 1;
          return args.result;
        },
      });
      const counted = new SqliteTodoRepository(counting);

      await counted.listActivitiesForTodos(['a', 'b', 'c']);
      expect(statements).toBe(1);

      statements = 0;
      await counted.listActivities('a');
      expect(statements).toBe(1);
    });
  });

  describe('activities and the item\'s lifecycle', () => {
    // Reach (m2, measured): removing `ON DELETE CASCADE` from the `todo_comments` clause of
    // `migrateToV52` fails this test and, in migration-v52.test.ts, 'todo_comments declares it'
    // and 'deleting a todo removes its rows in BOTH tables ...'.
    it('delete removes the item\'s comments and moves from BOTH tables (foreign key cascade) and leaves another item\'s', async () => {
      await repository.create(params({ id: 'todo-1' }));
      await repository.create(params({ id: 'todo-2' }));
      await repository.addComment({ todoId: 'todo-1', actor: { userId: 'u' }, text: 'x' });
      await repository.addMove(moveParams());
      await repository.addComment({ todoId: 'todo-2', actor: { userId: 'u' }, text: 'y' });
      await repository.addMove(moveParams({ todoId: 'todo-2' }));

      expect(await repository.delete('todo-1')).toBe(true);

      expect((await db.selectFrom('todo_comments').select('todo_id').execute()).map((r) => r.todo_id)).toEqual(['todo-2']);
      expect((await db.selectFrom('todo_moves').select('todo_id').execute()).map((r) => r.todo_id)).toEqual(['todo-2']);
      expect(await repository.listActivities('todo-1')).toEqual([]);
    });

    it('withdrawing an item (session deletion) keeps its activities', async () => {
      await repository.create(params());
      await repository.addComment({ todoId: 'todo-1', actor: { userId: 'u' }, text: 'x' });
      await repository.addMove(moveParams());

      expect(await repository.withdrawOpenSessionScoped('session-1')).toBe(1);

      expect((await repository.findById('todo-1'))!.status).toBe('withdrawn');
      expect(await repository.listActivities('todo-1')).toHaveLength(2);
      expect((await repository.findById('todo-1'))!.commentCount).toBe(1);
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
