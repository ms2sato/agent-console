/**
 * Sibling test for `SqliteArtifactRepository` (Issue #1312, HTML Artifacts
 * phase 1).
 *
 * Deliberately uses the REAL filesystem under `os.tmpdir()`, not memfs:
 * the repository writes artifact bytes via `lib/artifact-storage.ts`'s
 * `Bun.write` / `Bun.file`, which bypass the process-global
 * `mock.module('fs/promises')` interception other test files install
 * (`.claude/rules/testing.md` Anti-Pattern #2; see the parallel note in
 * `lib/__tests__/artifact-storage.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteArtifactRepository } from '../sqlite-artifact-repository.js';
import { readArtifactFile } from '../../lib/artifact-storage.js';

describe('SqliteArtifactRepository', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  let db: Kysely<Database>;
  let repository: SqliteArtifactRepository;
  let testHome: string;

  beforeEach(async () => {
    testHome = path.join(os.tmpdir(), `agent-console-artifact-repo-test-${randomUUID()}`);
    process.env.AGENT_CONSOLE_HOME = testHome;
    db = await createDatabaseForTest();
    repository = new SqliteArtifactRepository(db);

    // `artifacts.user_id` carries a real FK to `users.id` -- seed the two
    // synthetic users this file's tests attribute artifacts to.
    const now = new Date().toISOString();
    for (const id of ['user-1', 'user-2']) {
      await db
        .insertInto('users')
        .values({ id, os_uid: null, username: id, home_dir: `/home/${id}`, created_at: now, updated_at: now })
        .execute();
    }
  });

  afterEach(async () => {
    await db.destroy();
    // Remove the real on-disk temp directory this test wrote artifact
    // bytes into -- otherwise these accumulate under os.tmpdir() across
    // every test run (this suite deliberately uses the real filesystem,
    // not memfs, per the file header comment). `fs`/`fs/promises` may be
    // memfs-mocked by OTHER test files sharing this bun:test process
    // (`mock.module` is process-global and irreversible -- see
    // `.claude/rules/testing.md` Anti-Pattern #2), so cleanup goes through
    // a real subprocess instead, matching the established pattern in
    // `mcp/__tests__/create-html-artifact.test.ts` and
    // `embedded-agent-artifact-e2e.test.ts`.
    Bun.spawnSync(['rm', '-rf', testHome]);
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  describe('create', () => {
    it('creates a row and writes the HTML file, returning the wire summary', async () => {
      const artifact = await repository.create({
        id: 'artifact-1',
        userId: 'user-1',
        title: 'My Dashboard',
        content: '<html><body>hi</body></html>',
        sourceSessionId: 'session-1',
      });

      expect(artifact).toEqual({
        id: 'artifact-1',
        userId: 'user-1',
        title: 'My Dashboard',
        createdAt: artifact.createdAt,
        sizeBytes: Buffer.byteLength('<html><body>hi</body></html>', 'utf-8'),
      });
      // `create`/`findById` return the server-internal ArtifactRecord (wire
      // summary + userId, needed by route handlers for file-path resolution
      // and owner-only delete -- see repositories/artifact-repository.ts).
      // `content`/`sourceSessionId` still never leak; `userId` is NOT part
      // of the wire `Artifact` type and must never be serialized into an
      // HTTP response (see packages/shared/src/types/artifact.ts).
      expect(Object.keys(artifact).sort()).toEqual(['createdAt', 'id', 'sizeBytes', 'title', 'userId']);

      const written = await readArtifactFile('user-1', 'artifact-1');
      expect(written).toBe('<html><body>hi</body></html>');
    });

    it('computes sizeBytes from the raw UTF-8 byte length, not the JS string length', async () => {
      // A multi-byte character: 1 JS string char, 3 UTF-8 bytes.
      const content = '<p>あ</p>';
      const artifact = await repository.create({
        id: 'artifact-multibyte',
        userId: 'user-1',
        title: 'Multibyte',
        content,
        sourceSessionId: null,
      });

      expect(artifact.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'));
      expect(artifact.sizeBytes).not.toBe(content.length);
    });

    it('cleans up the file it just wrote when the DB insert fails, and propagates the original insert error', async () => {
      // Force an insert failure via a primary-key conflict: seed a raw row
      // for this id directly (bypassing the repository, so no file is
      // written for it), then call create() with the same id. The
      // repository's own insertInto will violate the PK constraint.
      await db
        .insertInto('artifacts')
        .values({
          id: 'artifact-dup',
          user_id: 'user-1',
          title: 'Pre-existing row',
          created_at: new Date().toISOString(),
          size_bytes: 1,
          source_session_id: null,
        })
        .execute();

      await expect(
        repository.create({
          id: 'artifact-dup',
          userId: 'user-1',
          title: 'Should not persist',
          content: '<p>should be cleaned up</p>',
          sourceSessionId: null,
        })
      ).rejects.toThrow(/UNIQUE constraint failed|constraint/i);

      // The file the failed create() wrote before the insert must not
      // remain on disk -- the recovery path deletes it.
      expect(await readArtifactFile('user-1', 'artifact-dup')).toBeNull();
    });
  });

  describe('findById', () => {
    it('returns null for a non-existent id', async () => {
      expect(await repository.findById('does-not-exist')).toBeNull();
    });

    it('finds an existing artifact', async () => {
      await repository.create({
        id: 'artifact-2',
        userId: 'user-1',
        title: 'Found Me',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const found = await repository.findById('artifact-2');
      expect(found?.id).toBe('artifact-2');
      expect(found?.title).toBe('Found Me');
    });
  });

  describe('findByUserId', () => {
    it('returns only the given user\'s artifacts, newest first', async () => {
      await repository.create({
        id: 'artifact-old',
        userId: 'user-1',
        title: 'Old',
        content: '<p>old</p>',
        sourceSessionId: null,
      });
      await new Promise((r) => setTimeout(r, 2));
      await repository.create({
        id: 'artifact-new',
        userId: 'user-1',
        title: 'New',
        content: '<p>new</p>',
        sourceSessionId: null,
      });
      await repository.create({
        id: 'artifact-other-user',
        userId: 'user-2',
        title: 'Other user',
        content: '<p>other</p>',
        sourceSessionId: null,
      });

      const results = await repository.findByUserId('user-1');
      expect(results.map((a) => a.id)).toEqual(['artifact-new', 'artifact-old']);
    });

    it('returns an empty array for a user with no artifacts', async () => {
      expect(await repository.findByUserId('nobody')).toEqual([]);
    });
  });

  describe('delete', () => {
    it('removes the row and the file together, returning true', async () => {
      await repository.create({
        id: 'artifact-3',
        userId: 'user-1',
        title: 'To delete',
        content: '<p>bye</p>',
        sourceSessionId: null,
      });

      const deleted = await repository.delete('artifact-3');
      expect(deleted).toBe(true);

      expect(await repository.findById('artifact-3')).toBeNull();
      expect(await readArtifactFile('user-1', 'artifact-3')).toBeNull();
    });

    it('returns false for a non-existent id, and does not throw', async () => {
      await expect(repository.delete('never-existed')).resolves.toBe(false);
    });
  });
});
