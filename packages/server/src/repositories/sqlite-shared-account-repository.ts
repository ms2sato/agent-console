import type { Kysely } from 'kysely';
import type { SharedAccountRepository, SharedAccountRow } from './shared-account-repository.js';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-shared-account-repository');

export class SqliteSharedAccountRepository implements SharedAccountRepository {
  constructor(private db: Kysely<Database>) {}

  async list(): Promise<SharedAccountRow[]> {
    const rows = await this.db
      .selectFrom('shared_accounts')
      .innerJoin('users', 'users.id', 'shared_accounts.user_id')
      .select([
        'shared_accounts.user_id as userId',
        'users.username as username',
        'shared_accounts.created_at as createdAt',
        'shared_accounts.created_by as createdBy',
      ])
      .execute();

    return rows;
  }

  async register(userId: string, createdBy: string | null): Promise<void> {
    await this.db
      .insertInto('shared_accounts')
      .values({ user_id: userId, created_by: createdBy })
      .execute();

    logger.debug({ userId, createdBy }, 'Shared account registered');
  }

  async unregister(userId: string): Promise<boolean> {
    // Deliberately does NOT catch a foreign-key-constraint error here: when
    // `userId` is bound to a repository, this delete throws (ON DELETE
    // RESTRICT) and the throw is the contract -- see this method's JSDoc on
    // the interface.
    const result = await this.db
      .deleteFrom('shared_accounts')
      .where('user_id', '=', userId)
      .execute();

    const unregistered = (result[0]?.numDeletedRows ?? 0n) > 0n;
    logger.debug({ userId, unregistered }, 'Shared account unregister attempted');
    return unregistered;
  }

  async countBoundRepositories(userId: string): Promise<number> {
    const result = await this.db
      .selectFrom('repositories')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('shared_account_user_id', '=', userId)
      .executeTakeFirst();

    return Number(result?.count ?? 0);
  }

  async countSessions(userId: string): Promise<number> {
    const result = await this.db
      .selectFrom('sessions')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('created_by', '=', userId)
      .executeTakeFirst();

    return Number(result?.count ?? 0);
  }
}
