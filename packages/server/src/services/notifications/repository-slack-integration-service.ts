/**
 * Service for managing repository-level Slack integrations.
 *
 * This service provides CRUD operations for per-repository Slack webhook
 * configurations that override global notification settings.
 */
import { getDatabase } from '../../database/connection.js';
import { createLogger } from '../../lib/logger.js';
import type { RepositorySlackIntegration } from '@agent-console/shared';
import type {
  RepositorySlackIntegrationRow,
  NewRepositorySlackIntegration,
  RepositorySlackIntegrationUpdate,
} from '../../database/schema.js';

const logger = createLogger('repository-slack-integration-service');

/**
 * Convert database row to API response type.
 * Handles the enabled field conversion from integer to boolean.
 */
function toRepositorySlackIntegration(row: RepositorySlackIntegrationRow): RepositorySlackIntegration {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    webhookUrl: row.webhook_url,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get Slack integration settings for a repository.
 * @param repositoryId - The repository ID to look up
 * @returns Integration settings if found, null otherwise
 */
export async function getByRepositoryId(
  repositoryId: string
): Promise<RepositorySlackIntegration | null> {
  const db = getDatabase();
  const row = await db
    .selectFrom('repository_slack_integrations')
    .selectAll()
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  return toRepositorySlackIntegration(row);
}

/**
 * Create new Slack integration settings for a repository.
 * @param repositoryId - The repository ID
 * @param webhookUrl - Slack webhook URL
 * @param enabled - Whether integration is enabled (default: true)
 * @returns Created integration settings
 * @throws Error if integration already exists for this repository
 */
export async function create(
  repositoryId: string,
  webhookUrl: string,
  enabled: boolean = true
): Promise<RepositorySlackIntegration> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const newIntegration: NewRepositorySlackIntegration = {
    id: crypto.randomUUID(),
    repository_id: repositoryId,
    webhook_url: webhookUrl,
    enabled: enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  await db.insertInto('repository_slack_integrations').values(newIntegration).execute();

  logger.info({ repositoryId }, 'Created Slack integration for repository');

  return {
    id: newIntegration.id,
    repositoryId: newIntegration.repository_id,
    webhookUrl: newIntegration.webhook_url,
    enabled,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update existing Slack integration settings for a repository.
 * @param repositoryId - The repository ID
 * @param webhookUrl - New webhook URL
 * @param enabled - New enabled status (optional)
 * @returns Updated integration settings
 * @throws Error if integration doesn't exist for this repository
 */
export async function update(
  repositoryId: string,
  webhookUrl: string,
  enabled?: boolean
): Promise<RepositorySlackIntegration> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const updates: RepositorySlackIntegrationUpdate = {
    webhook_url: webhookUrl,
    updated_at: now,
  };

  if (enabled !== undefined) {
    updates.enabled = enabled ? 1 : 0;
  }

  const result = await db
    .updateTable('repository_slack_integrations')
    .set(updates)
    .where('repository_id', '=', repositoryId)
    .returningAll()
    .executeTakeFirst();

  if (!result) {
    throw new Error(`Slack integration not found for repository: ${repositoryId}`);
  }

  logger.info({ repositoryId }, 'Updated Slack integration for repository');

  return toRepositorySlackIntegration(result);
}

/**
 * Create or update Slack integration settings for a repository.
 * Uses atomic upsert pattern with onConflict for database-level atomicity.
 * @param repositoryId - The repository ID
 * @param webhookUrl - Slack webhook URL
 * @param enabled - Whether integration is enabled (default: true)
 * @returns Created or updated integration settings
 */
export async function upsert(
  repositoryId: string,
  webhookUrl: string,
  enabled: boolean = true
): Promise<RepositorySlackIntegration> {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const result = await db
    .insertInto('repository_slack_integrations')
    .values({
      id,
      repository_id: repositoryId,
      webhook_url: webhookUrl,
      enabled: enabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column('repository_id').doUpdateSet({
        webhook_url: webhookUrl,
        enabled: enabled ? 1 : 0,
        updated_at: now,
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  logger.info({ repositoryId }, 'Upserted Slack integration for repository');

  return toRepositorySlackIntegration(result);
}

/**
 * Delete Slack integration settings for a repository.
 * @param repositoryId - The repository ID
 * @returns true if deleted, false if not found
 */
export async function deleteIntegration(repositoryId: string): Promise<boolean> {
  const db = getDatabase();

  const result = await db
    .deleteFrom('repository_slack_integrations')
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst();

  const deleted = result.numDeletedRows > 0n;

  if (deleted) {
    logger.info({ repositoryId }, 'Deleted Slack integration for repository');
  }

  return deleted;
}
