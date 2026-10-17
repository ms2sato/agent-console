/**
 * Migration v52 tests -- `todo_comments` and `todo_moves` (human TODO list v3
 * activities, docs/design/human-todo-list.md section 3).
 *
 * Two tables, one timeline. Unlike `todos` (which has no foreign keys because
 * a todo outlives its session), both tables carry a child-to-parent FK to
 * `todos(id) ON DELETE CASCADE`: the structural form of "deleted with the
 * item". Every FK / cascade case therefore runs with `PRAGMA foreign_keys = ON`,
 * which `initializeDatabase` sets and the raw v51 database below sets itself.
 */

import { describe, it, expect } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import {
  initializeDatabase,
  migrateToV50,
  migrateToV51,
  migrateToV52,
  LATEST_SCHEMA_VERSION,
} from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

const NOW = '2026-10-17T00:00:00.000Z';

interface PragmaForeignKeyListRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

async function v51Db(): Promise<Kysely<Database>> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: bunDb }) });
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  await migrateToV50(db);
  await migrateToV51(db);
  return db;
}

async function v52Db(): Promise<Kysely<Database>> {
  const db = await v51Db();
  await migrateToV52(db);
  return db;
}

async function insertTodo(db: Kysely<Database>, id: string): Promise<void> {
  await sql`
    INSERT INTO todos (id, kind, scope, title, body, session_id, created_user_id, created_at, updated_at)
    VALUES (${id}, 'action', 'session', 't', 'b', 'session-1', 'user-1', ${NOW}, ${NOW})
  `.execute(db);
}

async function insertComment(
  db: Kysely<Database>,
  fields: { id: string; todoId: string; userId?: string | null; workerId?: string | null; text?: string },
): Promise<void> {
  await sql`
    INSERT INTO todo_comments (id, todo_id, actor_user_id, actor_worker_id, text, created_at)
    VALUES (${fields.id}, ${fields.todoId}, ${fields.userId ?? null}, ${fields.workerId ?? null}, ${fields.text ?? 'hello'}, ${NOW})
  `.execute(db);
}

async function insertMove(
  db: Kysely<Database>,
  fields: {
    id: string;
    todoId: string;
    userId?: string | null;
    workerId?: string | null;
    fromSessionId?: string | null;
    toSessionId?: string | null;
    statement?: string | null;
    attributedUserId?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO todo_moves
      (id, todo_id, actor_user_id, actor_worker_id, from_session_id, to_session_id, statement, attributed_user_id, created_at)
    VALUES (
      ${fields.id}, ${fields.todoId}, ${fields.userId ?? null}, ${fields.workerId ?? null},
      ${fields.fromSessionId ?? null}, ${fields.toSessionId === undefined ? 'session-2' : fields.toSessionId},
      ${fields.statement ?? null}, ${fields.attributedUserId ?? null}, ${NOW}
    )
  `.execute(db);
}

async function count(db: Kysely<Database>, table: 'todo_comments' | 'todo_moves'): Promise<number> {
  const rows = (await sql.raw<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).execute(db)).rows;
  return rows[0]!.n;
}

describe('migration v52 (todo_comments, todo_moves)', () => {
  it('creates todo_comments with the approved columns', async () => {
    const db = await v52Db();
    try {
      const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(todo_comments)').execute(db)).rows;
      expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
        ['id', 'TEXT', 0, 1],
        ['todo_id', 'TEXT', 1, 0],
        ['actor_user_id', 'TEXT', 0, 0],
        ['actor_worker_id', 'TEXT', 0, 0],
        ['text', 'TEXT', 1, 0],
        ['created_at', 'TEXT', 1, 0],
      ]);
    } finally {
      await db.destroy();
    }
  });

  it('creates todo_moves with the approved columns (to_session_id NOT NULL, statement and attribution nullable)', async () => {
    const db = await v52Db();
    try {
      const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(todo_moves)').execute(db)).rows;
      expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
        ['id', 'TEXT', 0, 1],
        ['todo_id', 'TEXT', 1, 0],
        ['actor_user_id', 'TEXT', 0, 0],
        ['actor_worker_id', 'TEXT', 0, 0],
        ['from_session_id', 'TEXT', 0, 0],
        ['to_session_id', 'TEXT', 1, 0],
        ['statement', 'TEXT', 0, 0],
        ['attributed_user_id', 'TEXT', 0, 0],
        ['created_at', 'TEXT', 1, 0],
      ]);
    } finally {
      await db.destroy();
    }
  });

  it('creates the (todo_id, created_at) index on each table', async () => {
    const db = await v52Db();
    try {
      const indexes = (
        await sql<{ name: string; tbl_name: string }>`
          SELECT name, tbl_name FROM sqlite_master
          WHERE type = 'index' AND tbl_name IN ('todo_comments', 'todo_moves') AND name NOT LIKE 'sqlite_autoindex%'
          ORDER BY name
        `.execute(db)
      ).rows;
      expect(indexes).toEqual([
        { name: 'idx_todo_comments_todo_created', tbl_name: 'todo_comments' },
        { name: 'idx_todo_moves_todo_created', tbl_name: 'todo_moves' },
      ]);
    } finally {
      await db.destroy();
    }
  });

  describe('foreign key to todos(id) ON DELETE CASCADE', () => {
    it.each(['todo_comments', 'todo_moves'] as const)('%s declares it', async (table) => {
      const db = await v52Db();
      try {
        const fks = (await sql.raw<PragmaForeignKeyListRow>(`PRAGMA foreign_key_list(${table})`).execute(db)).rows;
        expect(fks).toHaveLength(1);
        expect(fks[0]).toMatchObject({ table: 'todos', from: 'todo_id', to: 'id', on_delete: 'CASCADE' });
      } finally {
        await db.destroy();
      }
    });

    it('a comment for an unknown todo_id is rejected under foreign_keys = ON', async () => {
      const db = await v52Db();
      try {
        await expect(insertComment(db, { id: 'c', todoId: 'no-such-todo', userId: 'u' })).rejects.toThrow(/FOREIGN KEY/);
        expect(await count(db, 'todo_comments')).toBe(0);
      } finally {
        await db.destroy();
      }
    });

    it('a move for an unknown todo_id is rejected under foreign_keys = ON', async () => {
      const db = await v52Db();
      try {
        await expect(insertMove(db, { id: 'm', todoId: 'no-such-todo', workerId: 'w' })).rejects.toThrow(/FOREIGN KEY/);
        expect(await count(db, 'todo_moves')).toBe(0);
      } finally {
        await db.destroy();
      }
    });

    it('deleting a todo removes its rows in BOTH tables and leaves another todo\'s rows', async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 'todo-a');
        await insertTodo(db, 'todo-b');
        await insertComment(db, { id: 'c-a', todoId: 'todo-a', userId: 'u' });
        await insertMove(db, { id: 'm-a', todoId: 'todo-a', workerId: 'w' });
        await insertComment(db, { id: 'c-b', todoId: 'todo-b', userId: 'u' });
        await insertMove(db, { id: 'm-b', todoId: 'todo-b', workerId: 'w' });

        await sql`DELETE FROM todos WHERE id = 'todo-a'`.execute(db);

        const comments = (await sql<{ id: string }>`SELECT id FROM todo_comments`.execute(db)).rows;
        const moves = (await sql<{ id: string }>`SELECT id FROM todo_moves`.execute(db)).rows;
        expect(comments.map((r) => r.id)).toEqual(['c-b']);
        expect(moves.map((r) => r.id)).toEqual(['m-b']);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('actor CHECK (exactly one of user and worker)', () => {
    it('todo_comments rejects two actors and no actor, accepts either alone', async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 't');
        await expect(insertComment(db, { id: 'both', todoId: 't', userId: 'u', workerId: 'w' })).rejects.toThrow(/todo_comments_actor_check/);
        await expect(insertComment(db, { id: 'none', todoId: 't' })).rejects.toThrow(/todo_comments_actor_check/);
        await insertComment(db, { id: 'user', todoId: 't', userId: 'u' });
        await insertComment(db, { id: 'worker', todoId: 't', workerId: 'w' });
        expect(await count(db, 'todo_comments')).toBe(2);
      } finally {
        await db.destroy();
      }
    });

    it('todo_moves rejects two actors and no actor, accepts either alone', async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 't');
        await expect(insertMove(db, { id: 'both', todoId: 't', userId: 'u', workerId: 'w' })).rejects.toThrow(/todo_moves_actor_check/);
        await expect(insertMove(db, { id: 'none', todoId: 't' })).rejects.toThrow(/todo_moves_actor_check/);
        await insertMove(db, { id: 'user', todoId: 't', userId: 'u' });
        await insertMove(db, { id: 'worker', todoId: 't', workerId: 'w' });
        expect(await count(db, 'todo_moves')).toBe(2);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('text and statement CHECKs', () => {
    it("todo_comments rejects an empty text (the schema's length(text) > 0)", async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 't');
        await expect(insertComment(db, { id: 'c', todoId: 't', userId: 'u', text: '' })).rejects.toThrow(/todo_comments_text_check/);
      } finally {
        await db.destroy();
      }
    });

    it("todo_moves rejects an empty-string statement (NULL, never '', means no words were given)", async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 't');
        await expect(insertMove(db, { id: 'm', todoId: 't', workerId: 'w', statement: '' })).rejects.toThrow(/todo_moves_statement_check/);
        await insertMove(db, { id: 'm-null', todoId: 't', workerId: 'w', statement: null });
        expect(await count(db, 'todo_moves')).toBe(1);
      } finally {
        await db.destroy();
      }
    });

    it('todo_moves_attribution_check rejects an attributed user without a statement, accepts it with one', async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 't');
        await expect(
          insertMove(db, { id: 'bad', todoId: 't', workerId: 'w', statement: null, attributedUserId: 'user-1' }),
        ).rejects.toThrow(/todo_moves_attribution_check/);
        await insertMove(db, { id: 'ok', todoId: 't', workerId: 'w', statement: 'take it', attributedUserId: 'user-1' });
        await insertMove(db, { id: 'ok-unattributed', todoId: 't', workerId: 'w', statement: 'take it', attributedUserId: null });
        expect(await count(db, 'todo_moves')).toBe(2);
      } finally {
        await db.destroy();
      }
    });

    it('todo_moves requires to_session_id but allows a NULL from_session_id', async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 't');
        await expect(insertMove(db, { id: 'no-to', todoId: 't', workerId: 'w', toSessionId: null })).rejects.toThrow(/NOT NULL/);
        await insertMove(db, { id: 'from-null', todoId: 't', workerId: 'w', fromSessionId: null });
        expect(await count(db, 'todo_moves')).toBe(1);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('upgrade and fresh database', () => {
    it('v51 -> v52 keeps existing todo rows, starts both tables empty, and sets user_version 52', async () => {
      const db = await v51Db();
      try {
        await insertTodo(db, 'todo-existing');

        await migrateToV52(db);

        const todos = await db.selectFrom('todos').select('id').execute();
        expect(todos.map((t) => t.id)).toEqual(['todo-existing']);
        expect(await count(db, 'todo_comments')).toBe(0);
        expect(await count(db, 'todo_moves')).toBe(0);
        const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(version.rows[0]?.user_version).toBe(52);
      } finally {
        await db.destroy();
      }
    });

    it('is idempotent: a second run keeps the rows written after the first', async () => {
      const db = await v52Db();
      try {
        await insertTodo(db, 't');
        await insertComment(db, { id: 'c', todoId: 't', userId: 'u' });

        await expect(migrateToV52(db)).resolves.toBeUndefined();

        expect(await count(db, 'todo_comments')).toBe(1);
      } finally {
        await db.destroy();
      }
    });

    it('a fresh database lands on the latest version with both tables present', async () => {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
      const db = await initializeDatabase(':memory:');
      try {
        const tables = (
          await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('todo_comments', 'todo_moves') ORDER BY name`.execute(db)
        ).rows;
        expect(tables.map((t) => t.name)).toEqual(['todo_comments', 'todo_moves']);
        const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(version.rows[0]?.user_version).toBe(LATEST_SCHEMA_VERSION);
      } finally {
        await db.destroy();
      }
    });
  });
});
