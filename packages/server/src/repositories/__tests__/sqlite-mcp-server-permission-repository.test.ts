/**
 * Sibling test for `SqliteMcpServerPermissionRepository`.
 *
 * Pure in-memory-DB test, no real filesystem needed -- same shape as
 * `sqlite-bookmark-repository.test.ts`. Every case runs for BOTH scope
 * kinds (`repository` and `path`, Issue #1786) via `describe.each`, since
 * the repository is backed by two physical tables selected by
 * `scope.kind` -- see `SqliteMcpServerPermissionRepository`'s own doc
 * comment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteMcpServerPermissionRepository } from '../sqlite-mcp-server-permission-repository.js';
import type { McpPermissionScope } from '../../lib/mcp-server-permissions.js';

const SCOPE_CASES: Array<{ label: string; scopeA: McpPermissionScope; scopeB: McpPermissionScope }> = [
  {
    label: 'repository scope',
    scopeA: { kind: 'repository', repositoryId: 'repo-1' },
    scopeB: { kind: 'repository', repositoryId: 'repo-2' },
  },
  {
    label: 'path scope',
    scopeA: { kind: 'path', locationPath: '/home/user/quick-project-1' },
    scopeB: { kind: 'path', locationPath: '/home/user/quick-project-2' },
  },
];

describe('SqliteMcpServerPermissionRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteMcpServerPermissionRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteMcpServerPermissionRepository(db);

    const now = new Date().toISOString();
    for (const id of ['repo-1', 'repo-2']) {
      await db
        .insertInto('repositories')
        .values({ id, name: id, path: `/tmp/${id}`, created_at: now, updated_at: now })
        .execute();
    }
    for (const id of ['user-1', 'user-2']) {
      await db
        .insertInto('users')
        .values({ id, os_uid: null, username: id, home_dir: `/home/${id}`, created_at: now, updated_at: now })
        .execute();
    }
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe.each(SCOPE_CASES)('$label', ({ scopeA, scopeB }) => {
    describe('upsert', () => {
      it('inserts a new row and returns it', async () => {
        const row = await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'allow',
          decidedBy: 'user-1',
        });

        expect(row.scope).toEqual(scopeA);
        expect(row.serverName).toBe('chrome-devtools');
        expect(row.configHash).toBe('hash-1');
        expect(row.decision).toBe('allow');
        expect(row.decidedBy).toBe('user-1');
        expect(row.id).toBeTruthy();
        expect(row.createdAt).toBeTruthy();
        expect(row.decidedAt).toBeTruthy();
      });

      it('overwrites decision/decidedBy/decidedAt on a repeat upsert against the same key, keeping the same id and createdAt', async () => {
        const first = await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'deny',
          decidedBy: 'user-1',
        });

        // Force a real time gap so decidedAt is verifiably moved forward, not
        // merely re-asserted with the same millisecond value.
        await new Promise((resolve) => setTimeout(resolve, 5));

        const second = await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'allow',
          decidedBy: 'user-2',
        });

        expect(second.id).toBe(first.id);
        expect(second.createdAt).toBe(first.createdAt);
        expect(second.decision).toBe('allow');
        expect(second.decidedBy).toBe('user-2');
        expect(second.decidedAt).not.toBe(first.decidedAt);
        expect(new Date(second.decidedAt).getTime()).toBeGreaterThan(new Date(first.decidedAt).getTime());

        const rows = await repository.listByScope(scopeA);
        expect(rows).toHaveLength(1);
      });

      it('gives a second, distinct key its own id', async () => {
        const first = await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'allow',
          decidedBy: 'user-1',
        });
        const second = await repository.upsert({
          scope: scopeA,
          serverName: 'other-server',
          configHash: 'hash-2',
          decision: 'deny',
          decidedBy: 'user-1',
        });

        expect(second.id).not.toBe(first.id);

        const rows = await repository.listByScope(scopeA);
        expect(rows).toHaveLength(2);
      });

      it('treats a changed configHash under the same server name as a distinct key', async () => {
        const first = await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'allow',
          decidedBy: 'user-1',
        });
        const second = await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-2',
          decision: 'allow',
          decidedBy: 'user-1',
        });

        expect(second.id).not.toBe(first.id);
        const rows = await repository.listByScope(scopeA);
        expect(rows).toHaveLength(2);
      });
    });

    describe('listByScope', () => {
      it('scopes to the given scope, no cross-contamination', async () => {
        await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'allow',
          decidedBy: 'user-1',
        });
        await repository.upsert({
          scope: scopeB,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'deny',
          decidedBy: 'user-1',
        });

        const rowsA = await repository.listByScope(scopeA);
        const rowsB = await repository.listByScope(scopeB);

        expect(rowsA).toHaveLength(1);
        expect(rowsA[0]?.decision).toBe('allow');
        expect(rowsB).toHaveLength(1);
        expect(rowsB[0]?.decision).toBe('deny');
      });

      it('returns an empty array for a scope with no rows (boundary value)', async () => {
        const rows = await repository.listByScope(scopeB);
        expect(rows).toEqual([]);
      });
    });

    describe('get', () => {
      it('returns null for a nonexistent key', async () => {
        const row = await repository.get(scopeA, 'chrome-devtools', 'hash-1');
        expect(row).toBeNull();
      });

      it('returns the row for an existing key', async () => {
        await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'allow',
          decidedBy: 'user-1',
        });

        const row = await repository.get(scopeA, 'chrome-devtools', 'hash-1');
        expect(row?.decision).toBe('allow');
      });
    });

    describe('CASCADE behavior', () => {
      it('removes the row when its decidedBy user is deleted', async () => {
        await repository.upsert({
          scope: scopeA,
          serverName: 'chrome-devtools',
          configHash: 'hash-1',
          decision: 'allow',
          decidedBy: 'user-1',
        });

        await db.deleteFrom('users').where('id', '=', 'user-1').execute();

        const rows = await repository.listByScope(scopeA);
        expect(rows).toEqual([]);
      });
    });
  });

  describe('repository scope: CASCADE on repository delete', () => {
    it('removes the row when its repository is deleted', async () => {
      await repository.upsert({
        scope: { kind: 'repository', repositoryId: 'repo-1' },
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });

      await db.deleteFrom('repositories').where('id', '=', 'repo-1').execute();

      const rows = await repository.listByScope({ kind: 'repository', repositoryId: 'repo-1' });
      expect(rows).toEqual([]);
    });
  });

  describe('path scope: no cascade on repository delete', () => {
    it('leaves the row intact when every repository is deleted -- there is no FK to repositories at all', async () => {
      const pathScope: McpPermissionScope = { kind: 'path', locationPath: '/home/user/quick-project' };
      await repository.upsert({
        scope: pathScope,
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });

      await db.deleteFrom('repositories').execute();

      const rows = await repository.listByScope(pathScope);
      expect(rows).toHaveLength(1);
    });
  });

  describe('scope isolation', () => {
    it('a repository scope and a path scope with identical (name, hash) never cross-contaminate', async () => {
      const repoScope: McpPermissionScope = { kind: 'repository', repositoryId: 'repo-1' };
      const pathScope: McpPermissionScope = { kind: 'path', locationPath: '/home/user/quick-project' };

      await repository.upsert({
        scope: repoScope,
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });
      await repository.upsert({
        scope: pathScope,
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'deny',
        decidedBy: 'user-1',
      });

      const repoRows = await repository.listByScope(repoScope);
      const pathRows = await repository.listByScope(pathScope);

      expect(repoRows).toHaveLength(1);
      expect(repoRows[0]?.decision).toBe('allow');
      expect(pathRows).toHaveLength(1);
      expect(pathRows[0]?.decision).toBe('deny');
    });
  });
});
