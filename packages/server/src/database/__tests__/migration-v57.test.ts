/**
 * Migration v57 tests -- `inbound_webhook_endpoints.reply_url` (the operator-set address a signed
 * reply is posted to) and `inbound_webhook_replies` (one row per reply an agent sends).
 */

import { describe, it, expect } from 'bun:test';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema.js';
import { ISO8601_GLOB_PATTERN } from '../schema-helpers.js';
import { initializeDatabase, migrateToV56, migrateToV57, LATEST_SCHEMA_VERSION } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

const ENDPOINTS = 'inbound_webhook_endpoints';
const DELIVERIES = 'inbound_webhook_deliveries';
const REPLIES = 'inbound_webhook_replies';

const TS = '2026-11-20T00:00:00.000Z';
const HASH = 'a'.repeat(64);

/**
 * A database at the real v56 shape: the v56 tables are rebuilt by `migrateToV56` itself (so the
 * endpoints table has no `reply_url` and there is no replies table), at user_version 56.
 */
async function v56Db(): Promise<Kysely<Database>> {
  const db = await initializeDatabase(':memory:');
  await sql.raw(`DROP TABLE ${REPLIES}`).execute(db);
  await sql.raw(`DROP TABLE ${DELIVERIES}`).execute(db);
  await sql.raw(`DROP TABLE ${ENDPOINTS}`).execute(db);
  await migrateToV56(db);
  return db;
}

async function userVersion(db: Kysely<Database>): Promise<number | undefined> {
  return (await sql<{ user_version: number }>`PRAGMA user_version`.execute(db)).rows[0]?.user_version;
}

async function ddlOf(db: Kysely<Database>, table: string): Promise<string> {
  return (await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(db)).rows[0]!.sql;
}

function constraintNames(ddl: string): string[] {
  return [...ddl.matchAll(/CONSTRAINT\s+(\w+)/g)].map((m) => m[1]!);
}

async function columns(db: Kysely<Database>, table: string): Promise<PragmaTableInfoRow[]> {
  return (await sql.raw<PragmaTableInfoRow>(`PRAGMA table_info(${table})`).execute(db)).rows;
}

async function countRows(db: Kysely<Database>, table: string): Promise<number> {
  return (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(db)).rows[0]!.n;
}

async function insertEndpointRaw(db: Kysely<Database>, id: string, replyUrl?: string): Promise<void> {
  // Raw SQL: at the v56 shape the typed column does not exist yet.
  if (replyUrl === undefined) {
    await sql`
      INSERT INTO inbound_webhook_endpoints (id, label, repository_id, instruction_text, secret, created_at, updated_at)
      VALUES (${id}, 'Slack', 'repo-1', 'Run it', 'whsec_abc', ${TS}, ${TS})
    `.execute(db);
  } else {
    await sql`
      INSERT INTO inbound_webhook_endpoints (id, label, repository_id, instruction_text, secret, reply_url, created_at, updated_at)
      VALUES (${id}, 'Slack', 'repo-1', 'Run it', 'whsec_abc', ${replyUrl}, ${TS}, ${TS})
    `.execute(db);
  }
}

async function insertDelivery(db: Kysely<Database>, endpointId: string, webhookId: string): Promise<void> {
  await db.insertInto('inbound_webhook_deliveries').values({ endpoint_id: endpointId, webhook_id: webhookId, received_at: TS }).execute();
}

interface ReplyOverrides {
  id?: string;
  endpoint_id?: string;
  webhook_id?: string;
  body_sha256?: string;
  attempt_count?: number;
  created_at?: string;
  last_attempt_at?: string | null;
}

async function insertReply(db: Kysely<Database>, o: ReplyOverrides = {}): Promise<void> {
  await db
    .insertInto('inbound_webhook_replies')
    .values({
      id: o.id ?? 'reply_1',
      endpoint_id: o.endpoint_id ?? 'ep-1',
      webhook_id: o.webhook_id ?? 'w1',
      session_id: 'session-1',
      body_sha256: o.body_sha256 ?? HASH,
      ...(o.attempt_count !== undefined ? { attempt_count: o.attempt_count } : {}),
      last_status: null,
      created_at: o.created_at ?? TS,
      last_attempt_at: o.last_attempt_at ?? null,
    })
    .execute();
}

async function migratedWithEndpoint(): Promise<Kysely<Database>> {
  const db = await v56Db();
  await db.insertInto('repositories').values({ id: 'repo-1', name: 'repo-1', path: '/tmp/repo-1' }).execute();
  await insertEndpointRaw(db, 'ep-1');
  await migrateToV57(db);
  return db;
}

describe('migration v57 (reply URL and replies)', () => {
  it('the v56 fixture really lacks the column and the table', async () => {
    const db = await v56Db();
    try {
      expect((await columns(db, ENDPOINTS)).map((c) => c.name)).not.toContain('reply_url');
      expect((await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name = ${REPLIES}`.execute(db)).rows).toEqual([]);
      expect(await userVersion(db)).toBe(56);
    } finally {
      await db.destroy();
    }
  });

  it('a v56 database with an endpoint row migrates and that row reads reply_url NULL', async () => {
    const db = await migratedWithEndpoint();
    try {
      const row = await db.selectFrom('inbound_webhook_endpoints').selectAll().where('id', '=', 'ep-1').executeTakeFirstOrThrow();
      expect(row.reply_url).toBeNull();
      expect(row.label).toBe('Slack');
      expect(await userVersion(db)).toBe(57);
    } finally {
      await db.destroy();
    }
  });

  it('adds exactly the reply_url column and creates the approved replies columns and index', async () => {
    const db = await migratedWithEndpoint();
    try {
      const endpointColumns = await columns(db, ENDPOINTS);
      expect(endpointColumns.map((c) => c.name)).toEqual([
        'id', 'label', 'repository_id', 'instruction_text', 'secret', 'previous_secret',
        'previous_secret_expires_at', 'created_at', 'updated_at', 'reply_url',
      ]);
      const replyUrl = endpointColumns.find((c) => c.name === 'reply_url')!;
      expect([replyUrl.type, replyUrl.notnull, replyUrl.pk]).toEqual(['TEXT', 0, 0]);

      expect((await columns(db, REPLIES)).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])).toEqual([
        ['id', 'TEXT', 0, null, 1],
        ['endpoint_id', 'TEXT', 1, null, 0],
        ['webhook_id', 'TEXT', 1, null, 0],
        ['session_id', 'TEXT', 1, null, 0],
        ['body_sha256', 'TEXT', 1, null, 0],
        ['attempt_count', 'INTEGER', 1, '0', 0],
        ['last_status', 'INTEGER', 0, null, 0],
        ['created_at', 'TEXT', 1, null, 0],
        ['last_attempt_at', 'TEXT', 0, null, 0],
      ]);

      const indexes = (await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${REPLIES} AND name LIKE 'idx_iwr_%'`.execute(db)).rows;
      expect(indexes.map((i) => i.name)).toEqual(['idx_iwr_delivery_session']);
      const indexColumns = (await sql<{ name: string }>`SELECT name FROM pragma_index_info('idx_iwr_delivery_session') ORDER BY seqno`.execute(db)).rows;
      expect(indexColumns.map((c) => c.name)).toEqual(['endpoint_id', 'webhook_id', 'session_id']);
    } finally {
      await db.destroy();
    }
  });

  it('declares the named CHECKs, the composite cascading foreign key, and the GLOB literal rendered from ISO8601_GLOB_PATTERN', async () => {
    const db = await migratedWithEndpoint();
    try {
      expect(await ddlOf(db, ENDPOINTS)).toContain(
        'iwe_reply_url_length_check CHECK (reply_url IS NULL OR length(reply_url) BETWEEN 1 AND 2048)',
      );
      const ddl = await ddlOf(db, REPLIES);
      expect(constraintNames(ddl)).toEqual([
        'iwr_body_sha256_length_check',
        'iwr_attempt_count_check',
        'iwr_created_at_check',
        'iwr_last_attempt_at_check',
      ]);
      expect(ddl).toContain('iwr_body_sha256_length_check CHECK (length(body_sha256) = 64)');
      expect(ddl).toContain('iwr_attempt_count_check CHECK (attempt_count >= 0)');
      expect(ddl).toContain(`iwr_created_at_check CHECK (created_at GLOB '${ISO8601_GLOB_PATTERN}')`);
      expect(ddl).toContain(
        `iwr_last_attempt_at_check CHECK (last_attempt_at IS NULL OR last_attempt_at GLOB '${ISO8601_GLOB_PATTERN}')`,
      );
      expect(ddl).toMatch(/FOREIGN KEY \(endpoint_id, webhook_id\)\s+REFERENCES inbound_webhook_deliveries\(endpoint_id, webhook_id\) ON DELETE CASCADE/);
      expect(ddl).not.toMatch(/session_id\s+TEXT NOT NULL\s+REFERENCES/);
    } finally {
      await db.destroy();
    }
  });

  it('a fresh database lands on the latest version with the column and the table', async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
    const db = await initializeDatabase(':memory:');
    try {
      expect((await columns(db, ENDPOINTS)).map((c) => c.name)).toContain('reply_url');
      expect(await countRows(db, REPLIES)).toBe(0);
      expect(await userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      await db.destroy();
    }
  });

  describe('reply_url length CHECK', () => {
    it('2048 characters accepted, 2049 and the empty string rejected, NULL accepted (insert and update)', async () => {
      const db = await migratedWithEndpoint();
      try {
        await insertEndpointRaw(db, 'ep-2048', 'x'.repeat(2048));
        await expect(insertEndpointRaw(db, 'ep-2049', 'x'.repeat(2049))).rejects.toThrow(/iwe_reply_url_length_check|CHECK constraint failed/);
        await expect(insertEndpointRaw(db, 'ep-empty', '')).rejects.toThrow(/iwe_reply_url_length_check|CHECK constraint failed/);
        await expect(
          db.updateTable('inbound_webhook_endpoints').set({ reply_url: 'x'.repeat(2049) }).where('id', '=', 'ep-1').execute(),
        ).rejects.toThrow(/CHECK constraint failed/);
        await db.updateTable('inbound_webhook_endpoints').set({ reply_url: null }).where('id', '=', 'ep-2048').execute();
        expect(await countRows(db, ENDPOINTS)).toBe(2);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('replies constraints', () => {
    async function freshWithDelivery(): Promise<Kysely<Database>> {
      const db = await migratedWithEndpoint();
      await insertDelivery(db, 'ep-1', 'w1');
      return db;
    }

    it('accepts a valid reply; attempt_count defaults to 0', async () => {
      const db = await freshWithDelivery();
      try {
        await insertReply(db);
        const row = await db.selectFrom('inbound_webhook_replies').selectAll().executeTakeFirstOrThrow();
        expect(row.attempt_count).toBe(0);
        expect(row.last_status).toBeNull();
      } finally {
        await db.destroy();
      }
    });

    it('body_sha256 must be exactly 64 characters', async () => {
      const db = await freshWithDelivery();
      try {
        await expect(insertReply(db, { id: 'r3', body_sha256: 'abc' })).rejects.toThrow(/iwr_body_sha256_length_check|CHECK constraint failed/);
        await expect(insertReply(db, { id: 'r65', body_sha256: 'a'.repeat(65) })).rejects.toThrow(/CHECK constraint failed/);
        expect(await countRows(db, REPLIES)).toBe(0);
      } finally {
        await db.destroy();
      }
    });

    it('attempt_count must not be negative', async () => {
      const db = await freshWithDelivery();
      try {
        await insertReply(db, { id: 'r0', attempt_count: 0 });
        await expect(insertReply(db, { id: 'rneg', attempt_count: -1 })).rejects.toThrow(/iwr_attempt_count_check|CHECK constraint failed/);
      } finally {
        await db.destroy();
      }
    });

    it('timestamps must be ISO 8601; last_attempt_at may be NULL', async () => {
      const db = await freshWithDelivery();
      try {
        await insertReply(db, { id: 'ok', last_attempt_at: TS });
        await expect(insertReply(db, { id: 'bad1', created_at: '2026-11-20 00:00:00' })).rejects.toThrow(/iwr_created_at_check|CHECK constraint failed/);
        await expect(insertReply(db, { id: 'bad2', last_attempt_at: 'now' })).rejects.toThrow(/iwr_last_attempt_at_check|CHECK constraint failed/);
      } finally {
        await db.destroy();
      }
    });

    it('rejects a reply for a delivery that does not exist (composite foreign key), and a duplicate id', async () => {
      const db = await freshWithDelivery();
      try {
        await expect(insertReply(db, { id: 'orphan', webhook_id: 'no-such-delivery' })).rejects.toThrow(/FOREIGN KEY constraint failed/);
        await insertReply(db, { id: 'dup' });
        await expect(insertReply(db, { id: 'dup' })).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
      } finally {
        await db.destroy();
      }
    });

    it('session_id has no foreign key: a reply is accepted for a session id that matches no session', async () => {
      const db = await freshWithDelivery();
      try {
        await insertReply(db);
        expect((await db.selectFrom('inbound_webhook_replies').select('session_id').executeTakeFirstOrThrow()).session_id).toBe('session-1');
      } finally {
        await db.destroy();
      }
    });
  });

  describe('cascades', () => {
    it('deleting an endpoint removes its delivery rows and their reply rows, and leaves another endpoint alone', async () => {
      const db = await migratedWithEndpoint();
      try {
        await insertEndpointRaw(db, 'ep-2');
        await insertDelivery(db, 'ep-1', 'w1');
        await insertDelivery(db, 'ep-1', 'w2');
        await insertDelivery(db, 'ep-2', 'w1');
        await insertReply(db, { id: 'r1', endpoint_id: 'ep-1', webhook_id: 'w1' });
        await insertReply(db, { id: 'r2', endpoint_id: 'ep-1', webhook_id: 'w2' });
        await insertReply(db, { id: 'r3', endpoint_id: 'ep-2', webhook_id: 'w1' });

        await db.deleteFrom('inbound_webhook_endpoints').where('id', '=', 'ep-1').execute();

        expect((await db.selectFrom('inbound_webhook_deliveries').select(['endpoint_id', 'webhook_id']).execute())).toEqual([
          { endpoint_id: 'ep-2', webhook_id: 'w1' },
        ]);
        expect((await db.selectFrom('inbound_webhook_replies').select('id').execute()).map((r) => r.id)).toEqual(['r3']);
      } finally {
        await db.destroy();
      }
    });

    it('deleting one delivery row removes only its replies', async () => {
      const db = await migratedWithEndpoint();
      try {
        await insertDelivery(db, 'ep-1', 'w1');
        await insertDelivery(db, 'ep-1', 'w2');
        await insertReply(db, { id: 'r1', webhook_id: 'w1' });
        await insertReply(db, { id: 'r2', webhook_id: 'w2' });
        await db.deleteFrom('inbound_webhook_deliveries').where('webhook_id', '=', 'w1').execute();
        expect((await db.selectFrom('inbound_webhook_replies').select('id').execute()).map((r) => r.id)).toEqual(['r2']);
      } finally {
        await db.destroy();
      }
    });
  });
});
