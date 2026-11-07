/**
 * Migration v56 tests -- `inbound_webhook_endpoints` (signed generic webhook receivers bound to a
 * repository) and `inbound_webhook_deliveries` (their dedupe ledger).
 */

import { describe, it, expect } from 'bun:test';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema.js';
import { ISO8601_GLOB_PATTERN } from '../schema-helpers.js';
import { initializeDatabase, migrateToV56, LATEST_SCHEMA_VERSION } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

const ENDPOINTS = 'inbound_webhook_endpoints';
const DELIVERIES = 'inbound_webhook_deliveries';

const TS = '2026-11-07T00:00:00.000Z';

/** A database at the v55 shape: a fully migrated one with the v56 tables removed. */
async function v55Db(): Promise<Kysely<Database>> {
  const db = await initializeDatabase(':memory:');
  await sql.raw(`DROP TABLE ${DELIVERIES}`).execute(db);
  await sql.raw(`DROP TABLE ${ENDPOINTS}`).execute(db);
  await sql`PRAGMA user_version = 55`.execute(db);
  return db;
}

async function userVersion(db: Kysely<Database>): Promise<number | undefined> {
  const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
  return version.rows[0]?.user_version;
}

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  const rows = (
    await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${ENDPOINTS}, ${DELIVERIES}) ORDER BY name`.execute(db)
  ).rows;
  return rows.map((r) => r.name);
}

async function ddlOf(db: Kysely<Database>, table: string): Promise<string> {
  return (await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(db)).rows[0]!.sql;
}

/** The names of the table's named constraints, in declaration order. */
function constraintNames(ddl: string): string[] {
  return [...ddl.matchAll(/CONSTRAINT\s+(\w+)/g)].map((m) => m[1]!);
}

async function seedRepository(db: Kysely<Database>, id = 'repo-1'): Promise<void> {
  await db.insertInto('repositories').values({ id, name: id, path: `/tmp/${id}` }).execute();
}

interface EndpointOverrides {
  id?: string;
  repository_id?: string;
  instruction_text?: string;
  created_at?: string;
  updated_at?: string;
  previous_secret_expires_at?: string | null;
}

async function insertEndpoint(db: Kysely<Database>, o: EndpointOverrides = {}): Promise<void> {
  await db
    .insertInto('inbound_webhook_endpoints')
    .values({
      id: o.id ?? 'ep-1',
      label: 'Slack',
      repository_id: o.repository_id ?? 'repo-1',
      instruction_text: o.instruction_text ?? 'Run the triage skill',
      secret: 'whsec_abc',
      previous_secret: null,
      previous_secret_expires_at: o.previous_secret_expires_at ?? null,
      created_at: o.created_at ?? TS,
      updated_at: o.updated_at ?? TS,
    })
    .execute();
}

async function countRows(db: Kysely<Database>, table: string): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(db);
  return result.rows[0]!.n;
}

describe('migration v56 (inbound webhook endpoints)', () => {
  it('the v55 fixture really lacks both tables', async () => {
    const db = await v55Db();
    try {
      expect(await tableNames(db)).toEqual([]);
      expect(await userVersion(db)).toBe(55);
    } finally {
      await db.destroy();
    }
  });

  it('creates exactly the approved columns of both tables (no job_id column) and the repository index', async () => {
    const db = await v55Db();
    try {
      await migrateToV56(db);

      const endpointColumns = (await sql.raw<PragmaTableInfoRow>(`PRAGMA table_info(${ENDPOINTS})`).execute(db)).rows;
      expect(endpointColumns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
        ['id', 'TEXT', 0, 1],
        ['label', 'TEXT', 1, 0],
        ['repository_id', 'TEXT', 1, 0],
        ['instruction_text', 'TEXT', 1, 0],
        ['secret', 'TEXT', 1, 0],
        ['previous_secret', 'TEXT', 0, 0],
        ['previous_secret_expires_at', 'TEXT', 0, 0],
        ['created_at', 'TEXT', 1, 0],
        ['updated_at', 'TEXT', 1, 0],
      ]);

      const deliveryColumns = (await sql.raw<PragmaTableInfoRow>(`PRAGMA table_info(${DELIVERIES})`).execute(db)).rows;
      expect(deliveryColumns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
        ['endpoint_id', 'TEXT', 1, 1],
        ['webhook_id', 'TEXT', 1, 2],
        ['received_at', 'TEXT', 1, 0],
      ]);

      const indexes = (
        await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${ENDPOINTS} AND name LIKE 'idx_iwe_%'`.execute(db)
      ).rows;
      expect(indexes.map((i) => i.name)).toEqual(['idx_iwe_repository']);
    } finally {
      await db.destroy();
    }
  });

  it('declares the named CHECKs and cascading foreign keys, with the GLOB literal rendered from ISO8601_GLOB_PATTERN', async () => {
    const db = await v55Db();
    try {
      await migrateToV56(db);
      const endpointsDdl = await ddlOf(db, ENDPOINTS);
      expect(constraintNames(endpointsDdl)).toEqual([
        'iwe_instruction_text_length_check',
        'iwe_created_at_check',
        'iwe_updated_at_check',
        'iwe_previous_secret_expires_at_check',
      ]);
      expect(endpointsDdl).toContain('iwe_instruction_text_length_check CHECK (length(instruction_text) <= 4000)');
      expect(endpointsDdl).toContain(`iwe_created_at_check CHECK (created_at GLOB '${ISO8601_GLOB_PATTERN}')`);
      expect(endpointsDdl).toContain(`iwe_updated_at_check CHECK (updated_at GLOB '${ISO8601_GLOB_PATTERN}')`);
      expect(endpointsDdl).toContain(
        `iwe_previous_secret_expires_at_check CHECK (previous_secret_expires_at IS NULL OR previous_secret_expires_at GLOB '${ISO8601_GLOB_PATTERN}')`,
      );
      expect(endpointsDdl).toContain('REFERENCES repositories(id) ON DELETE CASCADE');

      const deliveriesDdl = await ddlOf(db, DELIVERIES);
      expect(constraintNames(deliveriesDdl)).toEqual(['iwd_received_at_check']);
      expect(deliveriesDdl).toContain(`iwd_received_at_check CHECK (received_at GLOB '${ISO8601_GLOB_PATTERN}')`);
      expect(deliveriesDdl).toContain('REFERENCES inbound_webhook_endpoints(id) ON DELETE CASCADE');
    } finally {
      await db.destroy();
    }
  });

  it('sets user_version to 56 and is idempotent', async () => {
    const db = await v55Db();
    try {
      await migrateToV56(db);
      await expect(migrateToV56(db)).resolves.toBeUndefined();
      expect(await userVersion(db)).toBe(56);
      expect(await tableNames(db)).toEqual([DELIVERIES, ENDPOINTS]);
    } finally {
      await db.destroy();
    }
  });

  it('a fresh database lands on the latest version with both tables present', async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(56);
    const db = await initializeDatabase(':memory:');
    try {
      expect(await tableNames(db)).toEqual([DELIVERIES, ENDPOINTS]);
      expect(await userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      await db.destroy();
    }
  });

  describe('constraints', () => {
    async function freshDb(): Promise<Kysely<Database>> {
      const db = await initializeDatabase(':memory:');
      await seedRepository(db);
      return db;
    }

    it('accepts a valid endpoint, including an empty and a 4000-char instruction', async () => {
      const db = await freshDb();
      try {
        await insertEndpoint(db, { id: 'a' });
        await insertEndpoint(db, { id: 'b', instruction_text: '' });
        await insertEndpoint(db, { id: 'c', instruction_text: 'x'.repeat(4000) });
        expect(await countRows(db, ENDPOINTS)).toBe(3);
      } finally {
        await db.destroy();
      }
    });

    it('iwe_instruction_text_length_check rejects 4001 characters', async () => {
      const db = await freshDb();
      try {
        await expect(insertEndpoint(db, { id: 'long', instruction_text: 'x'.repeat(4001) })).rejects.toThrow(
          /iwe_instruction_text_length_check|CHECK constraint failed/,
        );
        expect(await countRows(db, ENDPOINTS)).toBe(0);
      } finally {
        await db.destroy();
      }
    });

    it('accepts a 4000-character instruction containing LF, CR and CRLF, stored as-is', async () => {
      const db = await freshDb();
      try {
        const text = `a\nb\rc\r\nd${'x'.repeat(4000 - 8)}`;
        expect(text.length).toBe(4000);
        await insertEndpoint(db, { id: 'multi', instruction_text: text });
        const row = await db.selectFrom('inbound_webhook_endpoints').select('instruction_text').where('id', '=', 'multi').executeTakeFirstOrThrow();
        expect(row.instruction_text).toBe(text);
      } finally {
        await db.destroy();
      }
    });

    it('iwe_instruction_text_length_check also fires on UPDATE', async () => {
      const db = await freshDb();
      try {
        await insertEndpoint(db);
        await expect(
          db.updateTable('inbound_webhook_endpoints').set({ instruction_text: 'x'.repeat(4001) }).where('id', '=', 'ep-1').execute(),
        ).rejects.toThrow(/CHECK constraint failed/);
      } finally {
        await db.destroy();
      }
    });

    it('iwe_created_at_check / iwe_updated_at_check reject a non-ISO8601 timestamp', async () => {
      const db = await freshDb();
      try {
        await expect(insertEndpoint(db, { id: 'x1', created_at: '2026-11-07 00:00:00' })).rejects.toThrow(/iwe_created_at_check|CHECK constraint failed/);
        await expect(insertEndpoint(db, { id: 'x2', updated_at: 'yesterday' })).rejects.toThrow(/iwe_updated_at_check|CHECK constraint failed/);
        await expect(insertEndpoint(db, { id: 'x3', created_at: '2026-XX-07T00:00:00Z' })).rejects.toThrow(/CHECK constraint failed/);
        expect(await countRows(db, ENDPOINTS)).toBe(0);
      } finally {
        await db.destroy();
      }
    });

    it('iwe_previous_secret_expires_at_check accepts NULL and ISO8601, rejects anything else', async () => {
      const db = await freshDb();
      try {
        await insertEndpoint(db, { id: 'n', previous_secret_expires_at: null });
        await insertEndpoint(db, { id: 'ok', previous_secret_expires_at: '2026-11-08T00:00:00.000Z' });
        await expect(insertEndpoint(db, { id: 'bad', previous_secret_expires_at: 'tomorrow' })).rejects.toThrow(
          /iwe_previous_secret_expires_at_check|CHECK constraint failed/,
        );
        expect(await countRows(db, ENDPOINTS)).toBe(2);
      } finally {
        await db.destroy();
      }
    });

    it('rejects an endpoint whose repository does not exist (foreign key)', async () => {
      const db = await freshDb();
      try {
        await expect(insertEndpoint(db, { repository_id: 'no-such-repo' })).rejects.toThrow(/FOREIGN KEY constraint failed/);
      } finally {
        await db.destroy();
      }
    });

    it('iwd_received_at_check rejects a non-ISO8601 timestamp', async () => {
      const db = await freshDb();
      try {
        await insertEndpoint(db);
        await expect(
          db.insertInto('inbound_webhook_deliveries').values({ endpoint_id: 'ep-1', webhook_id: 'w1', received_at: 'now' }).execute(),
        ).rejects.toThrow(/iwd_received_at_check|CHECK constraint failed/);
      } finally {
        await db.destroy();
      }
    });

    it('the (endpoint_id, webhook_id) primary key dedupes, scoped per endpoint', async () => {
      const db = await freshDb();
      try {
        await insertEndpoint(db, { id: 'ep-1' });
        await insertEndpoint(db, { id: 'ep-2' });
        const insert = (endpoint_id: string, webhook_id: string) =>
          db.insertInto('inbound_webhook_deliveries').values({ endpoint_id, webhook_id, received_at: TS }).execute();

        await insert('ep-1', 'w1');
        await expect(insert('ep-1', 'w1')).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
        await insert('ep-2', 'w1');
        expect(await countRows(db, DELIVERIES)).toBe(2);
      } finally {
        await db.destroy();
      }
    });

    it('rejects a delivery for an unknown endpoint (foreign key)', async () => {
      const db = await freshDb();
      try {
        await expect(
          db.insertInto('inbound_webhook_deliveries').values({ endpoint_id: 'ghost', webhook_id: 'w1', received_at: TS }).execute(),
        ).rejects.toThrow(/FOREIGN KEY constraint failed/);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('cascades', () => {
    it('deleting an endpoint deletes its deliveries and leaves other endpoints alone', async () => {
      const db = await initializeDatabase(':memory:');
      try {
        await seedRepository(db);
        await insertEndpoint(db, { id: 'ep-1' });
        await insertEndpoint(db, { id: 'ep-2' });
        for (const [endpoint_id, webhook_id] of [['ep-1', 'w1'], ['ep-1', 'w2'], ['ep-2', 'w1']] as const) {
          await db.insertInto('inbound_webhook_deliveries').values({ endpoint_id, webhook_id, received_at: TS }).execute();
        }

        await db.deleteFrom('inbound_webhook_endpoints').where('id', '=', 'ep-1').execute();

        const remaining = await db.selectFrom('inbound_webhook_deliveries').select(['endpoint_id', 'webhook_id']).execute();
        expect(remaining).toEqual([{ endpoint_id: 'ep-2', webhook_id: 'w1' }]);
      } finally {
        await db.destroy();
      }
    });

    it('deleting a repository deletes its endpoints and, through them, their deliveries', async () => {
      const db = await initializeDatabase(':memory:');
      try {
        await seedRepository(db, 'repo-1');
        await seedRepository(db, 'repo-2');
        await insertEndpoint(db, { id: 'ep-1', repository_id: 'repo-1' });
        await insertEndpoint(db, { id: 'ep-2', repository_id: 'repo-2' });
        await db.insertInto('inbound_webhook_deliveries').values({ endpoint_id: 'ep-1', webhook_id: 'w1', received_at: TS }).execute();
        await db.insertInto('inbound_webhook_deliveries').values({ endpoint_id: 'ep-2', webhook_id: 'w1', received_at: TS }).execute();

        await db.deleteFrom('repositories').where('id', '=', 'repo-1').execute();

        expect((await db.selectFrom('inbound_webhook_endpoints').select('id').execute()).map((r) => r.id)).toEqual(['ep-2']);
        expect((await db.selectFrom('inbound_webhook_deliveries').select('endpoint_id').execute()).map((r) => r.endpoint_id)).toEqual(['ep-2']);
      } finally {
        await db.destroy();
      }
    });
  });
});
