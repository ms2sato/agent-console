import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteInboundWebhookEndpointRepository } from '../sqlite-inbound-webhook-endpoint-repository.js';

const T0 = '2026-11-07T00:00:00.000Z';
const T1 = '2026-11-07T01:00:00.000Z';
const T2 = '2026-11-07T02:00:00.000Z';
const EXPIRY = '2026-11-08T01:00:00.000Z';

describe('SqliteInboundWebhookEndpointRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteInboundWebhookEndpointRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteInboundWebhookEndpointRepository(db);
    await db.insertInto('repositories').values({ id: 'repo-1', name: 'repo-1', path: '/tmp/repo-1' }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  function create(id: string, overrides: Partial<Parameters<SqliteInboundWebhookEndpointRepository['create']>[0]> = {}) {
    return repository.create({
      id,
      label: `label-${id}`,
      repositoryId: 'repo-1',
      instructionText: 'Run the triage skill',
      secret: `whsec_${id}`,
      now: T0,
      ...overrides,
    });
  }

  describe('create', () => {
    it('returns the row with its secret and no previous secret', async () => {
      const created = await create('ep-1');
      expect(created).toEqual({
        id: 'ep-1',
        label: 'label-ep-1',
        repositoryId: 'repo-1',
        instructionText: 'Run the triage skill',
        secret: 'whsec_ep-1',
        previousSecret: null,
        previousSecretExpiresAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
    });

    it('throws for an unknown repository and for a multi-line instruction', async () => {
      await expect(create('a', { repositoryId: 'nope' })).rejects.toThrow(/FOREIGN KEY/);
      await expect(create('b', { instructionText: 'x\ny' })).rejects.toThrow(/CHECK constraint failed/);
      expect(await repository.list()).toEqual([]);
    });
  });

  describe('reads never carry a secret', () => {
    it('list, findById and update return views without secret keys or values', async () => {
      await create('ep-1', { secret: 'whsec_SENTINEL_CURRENT' });
      await repository.rotateSecret('ep-1', 'whsec_SENTINEL_NEXT', EXPIRY, T1);

      const listed = await repository.list();
      const found = await repository.findById('ep-1');
      const updated = await repository.update('ep-1', { label: 'renamed' }, T2);
      const cleared = await repository.clearPreviousSecret('ep-1', T2);

      for (const view of [...listed, found, updated, cleared]) {
        const text = JSON.stringify(view);
        expect(text).not.toContain('SENTINEL');
        expect(Object.keys(view!)).not.toContain('secret');
        expect(Object.keys(view!)).not.toContain('previousSecret');
      }
    });
  });

  describe('list', () => {
    it('is empty on a fresh database and ordered oldest first', async () => {
      expect(await repository.list()).toEqual([]);
      await create('b', { now: T1 });
      await create('a', { now: T0 });
      await create('c', { now: T1 });
      expect((await repository.list()).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('findById / findWithSecretById', () => {
    it('return null for an unknown id', async () => {
      expect(await repository.findById('nope')).toBeNull();
      expect(await repository.findWithSecretById('nope')).toBeNull();
    });

    it('findWithSecretById returns both secrets', async () => {
      await create('ep-1');
      await repository.rotateSecret('ep-1', 'whsec_new', EXPIRY, T1);
      const found = await repository.findWithSecretById('ep-1');
      expect(found).toMatchObject({ secret: 'whsec_new', previousSecret: 'whsec_ep-1', previousSecretExpiresAt: EXPIRY });
    });
  });

  describe('update', () => {
    it('changes only the given fields, touches updated_at, and never the secret', async () => {
      await create('ep-1');
      const afterLabel = await repository.update('ep-1', { label: 'new label' }, T1);
      expect(afterLabel).toMatchObject({ label: 'new label', instructionText: 'Run the triage skill', createdAt: T0, updatedAt: T1 });

      const afterInstruction = await repository.update('ep-1', { instructionText: 'other' }, T2);
      expect(afterInstruction).toMatchObject({ label: 'new label', instructionText: 'other', updatedAt: T2 });

      expect((await repository.findWithSecretById('ep-1'))?.secret).toBe('whsec_ep-1');
    });

    it('returns null for an unknown id', async () => {
      expect(await repository.update('nope', { label: 'x' }, T1)).toBeNull();
    });
  });

  describe('rotateSecret', () => {
    it('moves the current secret to previous with the expiry and installs the new one', async () => {
      await create('ep-1');
      const rotated = await repository.rotateSecret('ep-1', 'whsec_new', EXPIRY, T1);
      expect(rotated).toMatchObject({ secret: 'whsec_new', previousSecret: 'whsec_ep-1', previousSecretExpiresAt: EXPIRY, updatedAt: T1, createdAt: T0 });
    });

    it('a second rotation replaces the previous secret with the then-current one', async () => {
      await create('ep-1');
      await repository.rotateSecret('ep-1', 'whsec_second', EXPIRY, T1);
      const rotated = await repository.rotateSecret('ep-1', 'whsec_third', '2026-11-08T02:00:00.000Z', T2);
      expect(rotated).toMatchObject({ secret: 'whsec_third', previousSecret: 'whsec_second', previousSecretExpiresAt: '2026-11-08T02:00:00.000Z' });
    });

    it('returns null for an unknown id', async () => {
      expect(await repository.rotateSecret('nope', 'whsec_x', EXPIRY, T1)).toBeNull();
    });
  });

  describe('clearPreviousSecret', () => {
    it('nulls both previous columns and keeps the current secret', async () => {
      await create('ep-1');
      await repository.rotateSecret('ep-1', 'whsec_new', EXPIRY, T1);
      const cleared = await repository.clearPreviousSecret('ep-1', T2);
      expect(cleared).toMatchObject({ previousSecretExpiresAt: null, updatedAt: T2 });

      const row = await db.selectFrom('inbound_webhook_endpoints').selectAll().where('id', '=', 'ep-1').executeTakeFirstOrThrow();
      expect(row.previous_secret).toBeNull();
      expect(row.previous_secret_expires_at).toBeNull();
      expect(row.secret).toBe('whsec_new');
    });

    it('is a no-op success when there is no previous secret, and null for an unknown id', async () => {
      await create('ep-1');
      expect(await repository.clearPreviousSecret('ep-1', T1)).toMatchObject({ previousSecretExpiresAt: null });
      expect(await repository.clearPreviousSecret('nope', T1)).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the row and its deliveries, and reports whether anything was deleted', async () => {
      await create('ep-1');
      await db.insertInto('inbound_webhook_deliveries').values({ endpoint_id: 'ep-1', webhook_id: 'w1', received_at: T0 }).execute();

      expect(await repository.delete('ep-1')).toBe(true);
      expect(await repository.findById('ep-1')).toBeNull();
      expect(await db.selectFrom('inbound_webhook_deliveries').selectAll().execute()).toEqual([]);
      expect(await repository.delete('ep-1')).toBe(false);
    });
  });
});
