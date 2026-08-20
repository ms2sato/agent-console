import type { Kysely } from 'kysely';
import type { Bookmark } from '@agent-console/shared';
import type { BookmarkRepository, BookmarkRecord, CreateBookmarkParams } from './bookmark-repository.js';
import type { Database } from '../database/schema.js';
import { toBookmark, toBookmarkRecord } from '../database/mappers.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-bookmark-repository');

export class SqliteBookmarkRepository implements BookmarkRepository {
  constructor(private db: Kysely<Database>) {}

  async create(params: CreateBookmarkParams): Promise<BookmarkRecord> {
    const now = new Date().toISOString();

    await this.db
      .insertInto('bookmarks')
      .values({
        id: params.id,
        user_id: params.userId,
        source_session_id: params.sourceSessionId,
        url: params.url,
        title: params.title,
        created_at: now,
      })
      .execute();

    logger.debug({ bookmarkId: params.id, userId: params.userId }, 'Bookmark created');

    // findById will always succeed immediately after insert
    return (await this.findById(params.id))!;
  }

  async findById(id: string): Promise<BookmarkRecord | null> {
    const row = await this.db
      .selectFrom('bookmarks')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    return row ? toBookmarkRecord(row) : null;
  }

  async findByUserId(userId: string): Promise<Bookmark[]> {
    const rows = await this.db
      .selectFrom('bookmarks')
      .where('user_id', '=', userId)
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toBookmark);
  }

  async findByUserIdAndSourceSessionId(userId: string, sessionId: string): Promise<Bookmark[]> {
    const rows = await this.db
      .selectFrom('bookmarks')
      .where('user_id', '=', userId)
      .where('source_session_id', '=', sessionId)
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toBookmark);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('bookmarks').where('id', '=', id).execute();
    const deleted = (result[0]?.numDeletedRows ?? 0n) > 0n;
    if (deleted) {
      logger.debug({ bookmarkId: id }, 'Bookmark deleted');
    }
    return deleted;
  }
}
