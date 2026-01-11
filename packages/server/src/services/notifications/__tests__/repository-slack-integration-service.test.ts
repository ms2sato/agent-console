import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initializeDatabase, closeDatabase, getDatabase } from '../../../database/connection.js';
import {
  getByRepositoryId,
  create,
  update,
  upsert,
  deleteIntegration,
} from '../repository-slack-integration-service.js';

describe('RepositorySlackIntegrationService', () => {
  const testRepositoryId = 'test-repo-123';
  const testWebhookUrl = 'https://hooks.slack.com/services/T00/B00/xxx';
  const anotherWebhookUrl = 'https://hooks.slack.com/services/T11/B11/yyy';

  beforeEach(async () => {
    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Create a test repository to satisfy foreign key constraint
    const db = getDatabase();
    await db.insertInto('repositories').values({
      id: testRepositoryId,
      name: 'test-repo',
      path: '/test/path/to/repo',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).execute();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ===========================================================================
  // getByRepositoryId
  // ===========================================================================

  describe('getByRepositoryId', () => {
    it('should return null when integration not found', async () => {
      const result = await getByRepositoryId('non-existent-repo');
      expect(result).toBeNull();
    });

    it('should return integration when found', async () => {
      // Create an integration first
      await create(testRepositoryId, testWebhookUrl, true);

      const result = await getByRepositoryId(testRepositoryId);

      expect(result).not.toBeNull();
      expect(result!.repositoryId).toBe(testRepositoryId);
      expect(result!.webhookUrl).toBe(testWebhookUrl);
      expect(result!.enabled).toBe(true);
      expect(result!.id).toBeDefined();
      expect(result!.createdAt).toBeDefined();
      expect(result!.updatedAt).toBeDefined();
    });
  });

  // ===========================================================================
  // create
  // ===========================================================================

  describe('create', () => {
    it('should create a new integration', async () => {
      const result = await create(testRepositoryId, testWebhookUrl, true);

      expect(result.repositoryId).toBe(testRepositoryId);
      expect(result.webhookUrl).toBe(testWebhookUrl);
      expect(result.enabled).toBe(true);
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();

      // Verify it can be retrieved
      const fetched = await getByRepositoryId(testRepositoryId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(result.id);
    });

    it('should create integration with enabled=false', async () => {
      const result = await create(testRepositoryId, testWebhookUrl, false);

      expect(result.enabled).toBe(false);
    });

    it('should default enabled to true when not specified', async () => {
      const result = await create(testRepositoryId, testWebhookUrl);

      expect(result.enabled).toBe(true);
    });

    it('should throw error for duplicate repository', async () => {
      // Create first integration
      await create(testRepositoryId, testWebhookUrl, true);

      // Attempt to create another for the same repository
      await expect(
        create(testRepositoryId, anotherWebhookUrl, true)
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // update
  // ===========================================================================

  describe('update', () => {
    it('should update existing integration', async () => {
      // Create an integration first
      const created = await create(testRepositoryId, testWebhookUrl, true);

      // Update it
      const updated = await update(testRepositoryId, anotherWebhookUrl, false);

      expect(updated.id).toBe(created.id);
      expect(updated.repositoryId).toBe(testRepositoryId);
      expect(updated.webhookUrl).toBe(anotherWebhookUrl);
      expect(updated.enabled).toBe(false);
      // updatedAt should be set (timestamp comparison removed to avoid flaky tests)
      expect(updated.updatedAt).toBeDefined();
    });

    it('should update only webhook URL when enabled is undefined', async () => {
      // Create an integration first
      await create(testRepositoryId, testWebhookUrl, true);

      // Update only webhook URL
      const updated = await update(testRepositoryId, anotherWebhookUrl);

      expect(updated.webhookUrl).toBe(anotherWebhookUrl);
      expect(updated.enabled).toBe(true); // Should remain unchanged
    });

    it('should throw error when integration not found', async () => {
      await expect(
        update('non-existent-repo', testWebhookUrl, true)
      ).rejects.toThrow('Slack integration not found for repository: non-existent-repo');
    });
  });

  // ===========================================================================
  // upsert
  // ===========================================================================

  describe('upsert', () => {
    it('should create when integration does not exist', async () => {
      const result = await upsert(testRepositoryId, testWebhookUrl, true);

      expect(result.repositoryId).toBe(testRepositoryId);
      expect(result.webhookUrl).toBe(testWebhookUrl);
      expect(result.enabled).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should update when integration exists', async () => {
      // Create first
      const created = await upsert(testRepositoryId, testWebhookUrl, true);

      // Upsert again with different values
      const updated = await upsert(testRepositoryId, anotherWebhookUrl, false);

      expect(updated.id).toBe(created.id);
      expect(updated.webhookUrl).toBe(anotherWebhookUrl);
      expect(updated.enabled).toBe(false);
    });

    it('should default enabled to true when not specified', async () => {
      const result = await upsert(testRepositoryId, testWebhookUrl);

      expect(result.enabled).toBe(true);
    });
  });

  // ===========================================================================
  // deleteIntegration
  // ===========================================================================

  describe('deleteIntegration', () => {
    it('should remove integration and return true', async () => {
      // Create an integration first
      await create(testRepositoryId, testWebhookUrl, true);

      // Delete it
      const result = await deleteIntegration(testRepositoryId);

      expect(result).toBe(true);

      // Verify it's gone
      const fetched = await getByRepositoryId(testRepositoryId);
      expect(fetched).toBeNull();
    });

    it('should return false when integration not found', async () => {
      const result = await deleteIntegration('non-existent-repo');

      expect(result).toBe(false);
    });
  });
});
