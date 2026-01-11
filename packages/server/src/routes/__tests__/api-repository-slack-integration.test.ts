import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import type { RepositorySlackIntegration } from '@agent-console/shared';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { initializeJobQueue, resetJobQueue } from '../../jobs/index.js';
import { initializeRepositoryManager, resetRepositoryManager } from '../../services/repository-manager.js';
import { SqliteRepositoryRepository } from '../../repositories/index.js';
import { api } from '../api.js';
import { onApiError } from '../../lib/error-handler.js';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from '../../__tests__/utils/mock-fs-helper.js';

describe('Repository Slack Integration API', () => {
  let app: Hono;
  let repositoryRepository: SqliteRepositoryRepository;
  const testRepositoryId = 'test-repo-123';
  const testRepoPath = '/test/path/to/repo';
  const testWebhookUrl = 'https://hooks.slack.com/services/T00/B00/xxx';
  const anotherWebhookUrl = 'https://hooks.slack.com/services/T11/B11/yyy';

  beforeEach(async () => {
    // Reset singletons to ensure clean state (in case previous test didn't clean up)
    resetRepositoryManager();
    await resetJobQueue();

    // Setup memfs with mock git repository structure
    // This is required because RepositoryManager checks if path exists on filesystem
    const gitRepoFiles = createMockGitRepoFiles(testRepoPath);
    setupMemfs(gitRepoFiles);

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Initialize the singleton job queue
    const testJobQueue = initializeJobQueue();

    // Create repository repository backed by in-memory SQLite
    repositoryRepository = new SqliteRepositoryRepository(getDatabase());

    // Pre-populate test repository BEFORE initializing the manager.
    // This is necessary because RepositoryManager loads repositories at initialization
    // and caches them in memory. The getRepository() method only reads from cache.
    await repositoryRepository.save({
      id: testRepositoryId,
      name: 'test-repo',
      path: testRepoPath,
      createdAt: new Date().toISOString(),
    });

    // Initialize repository manager singleton (will load the pre-created repository)
    await initializeRepositoryManager({
      repository: repositoryRepository,
      jobQueue: testJobQueue,
    });

    // Create Hono app with error handler
    app = new Hono();
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    resetRepositoryManager();
    await resetJobQueue();
    await closeDatabase();
    cleanupMemfs();
  });

  // ===========================================================================
  // GET /api/repositories/:id/integrations/slack
  // ===========================================================================

  describe('GET /api/repositories/:id/integrations/slack', () => {
    it('should return 404 when integration not found', async () => {
      // Repository exists but no integration
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`);
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Slack integration not found');
    });

    it('should return integration when found', async () => {
      // Create an integration first
      await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: testWebhookUrl,
          enabled: true,
        }),
      });

      // Get it
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as RepositorySlackIntegration;
      expect(body.repositoryId).toBe(testRepositoryId);
      expect(body.webhookUrl).toBe(testWebhookUrl);
      expect(body.enabled).toBe(true);
      expect(body.id).toBeDefined();
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });
  });

  // ===========================================================================
  // PUT /api/repositories/:id/integrations/slack
  // ===========================================================================

  describe('PUT /api/repositories/:id/integrations/slack', () => {
    it('should create new integration', async () => {
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: testWebhookUrl,
          enabled: true,
        }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as RepositorySlackIntegration;
      expect(body.repositoryId).toBe(testRepositoryId);
      expect(body.webhookUrl).toBe(testWebhookUrl);
      expect(body.enabled).toBe(true);
      expect(body.id).toBeDefined();
    });

    it('should update existing integration', async () => {
      // Create first
      await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: testWebhookUrl,
          enabled: true,
        }),
      });

      // Update
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: anotherWebhookUrl,
          enabled: false,
        }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as RepositorySlackIntegration;
      expect(body.repositoryId).toBe(testRepositoryId);
      expect(body.webhookUrl).toBe(anotherWebhookUrl);
      expect(body.enabled).toBe(false);
    });

    it('should return 404 when repository not found', async () => {
      // Use a non-existent repository ID
      const res = await app.request(`/api/repositories/non-existent-repo/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: testWebhookUrl,
          enabled: true,
        }),
      });
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Repository');
    });

    it('should validate webhook URL format - missing https://hooks.slack.com/', async () => {
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: 'https://example.com/webhook',
          enabled: true,
        }),
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBeDefined();
    });

    it('should validate webhook URL format - empty string', async () => {
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: '',
          enabled: true,
        }),
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Webhook URL');
    });

    it('should default enabled to true when not specified', async () => {
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: testWebhookUrl,
        }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as RepositorySlackIntegration;
      expect(body.enabled).toBe(true);
    });
  });

  // ===========================================================================
  // DELETE /api/repositories/:id/integrations/slack
  // ===========================================================================

  describe('DELETE /api/repositories/:id/integrations/slack', () => {
    it('should remove integration', async () => {
      // Create first
      await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: testWebhookUrl,
          enabled: true,
        }),
      });

      // Delete
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`);
      expect(getRes.status).toBe(404);
    });

    it('should return 404 when integration not found', async () => {
      // Repository exists but no integration
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Slack integration not found');
    });
  });
});
