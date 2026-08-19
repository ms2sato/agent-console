import type { Kysely } from 'kysely';
import type { Artifact } from '@agent-console/shared';
import type { ArtifactRepository, ArtifactRecord, CreateArtifactParams } from './artifact-repository.js';
import type { Database } from '../database/schema.js';
import { toArtifact, toArtifactRecord } from '../database/mappers.js';
import { writeArtifactFile, deleteArtifactFile } from '../lib/artifact-storage.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-artifact-repository');

export class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private db: Kysely<Database>) {}

  async create(params: CreateArtifactParams): Promise<ArtifactRecord> {
    const sizeBytes = Buffer.byteLength(params.content, 'utf-8');
    const now = new Date().toISOString();

    // Write the file BEFORE the DB row: a crash between the two leaves an
    // orphan file (harmless, no row references it) rather than a phantom
    // row with no backing file (which a reader would see and then 404/error
    // on, a worse failure mode).
    await writeArtifactFile(params.userId, params.id, params.content);

    try {
      await this.db
        .insertInto('artifacts')
        .values({
          id: params.id,
          user_id: params.userId,
          title: params.title,
          created_at: now,
          size_bytes: sizeBytes,
          source_session_id: params.sourceSessionId,
        })
        .execute();
    } catch (err) {
      // The insert failed (e.g. a duplicate id, or a transient DB error).
      // Clean up the file we just wrote -- best-effort: a cleanup failure
      // is logged but must not mask the original insert error, which is
      // what actually caused create() to fail and must propagate to the
      // caller.
      try {
        await deleteArtifactFile(params.userId, params.id);
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, artifactId: params.id, userId: params.userId },
          'Failed to clean up artifact file after a DB insert failure'
        );
      }
      throw err;
    }

    logger.debug({ artifactId: params.id, userId: params.userId, sizeBytes }, 'Artifact created');

    // findById will always succeed immediately after insert
    return (await this.findById(params.id))!;
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    const row = await this.db
      .selectFrom('artifacts')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    return row ? toArtifactRecord(row) : null;
  }

  async findByUserId(userId: string): Promise<Artifact[]> {
    const rows = await this.db
      .selectFrom('artifacts')
      .where('user_id', '=', userId)
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toArtifact);
  }

  async findByUserIdAndSourceSessionId(userId: string, sessionId: string): Promise<Artifact[]> {
    const rows = await this.db
      .selectFrom('artifacts')
      .where('user_id', '=', userId)
      .where('source_session_id', '=', sessionId)
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toArtifact);
  }

  async delete(id: string): Promise<boolean> {
    // Look up user_id first: it is needed to locate the on-disk file, and
    // the row is about to be deleted.
    const existing = await this.db
      .selectFrom('artifacts')
      .where('id', '=', id)
      .select('user_id')
      .executeTakeFirst();
    if (!existing) {
      return false;
    }

    // Delete the file BEFORE the DB row: if file deletion fails (anything
    // other than ENOENT, which deleteArtifactFile already tolerates), the
    // row survives, so the artifact stays visible/findable and delete()
    // can simply be retried. The previous order (row-then-file) could
    // delete the row and then fail to delete the file, orphaning the file
    // on disk with no DB record left pointing at it -- strictly worse,
    // since nothing can find or retry it afterward.
    await deleteArtifactFile(existing.user_id, id);

    const result = await this.db.deleteFrom('artifacts').where('id', '=', id).execute();
    const deleted = (result[0]?.numDeletedRows ?? 0n) > 0n;
    if (deleted) {
      logger.debug({ artifactId: id, userId: existing.user_id }, 'Artifact deleted');
    }
    return deleted;
  }
}
