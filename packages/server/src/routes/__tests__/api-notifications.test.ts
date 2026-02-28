import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import {
  upsertRepositorySlackIntegration,
} from '../../services/notifications/index.js';
import { NotificationManager } from '../../services/notifications/notification-manager.js';
import { SlackHandler } from '../../services/notifications/slack-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from '../../__tests__/utils/mock-fs-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { SqliteRepositoryRepository } from '../../repositories/index.js';

describe('Notifications API', () => {
  let app: Hono<AppBindings>;
  let repositoryRepository: SqliteRepositoryRepository;
  let testJobQueue: JobQueue;
  const testRepositoryId = 'test-repo-123';
  const testRepoPath = '/test/path/to/repo';
  const testWebhookUrl = 'https://hooks.slack.com/services/T00/B00/xxx';

  beforeEach(async () => {
    // Setup memfs with mock git repository structure
    const gitRepoFiles = createMockGitRepoFiles(testRepoPath);
    setupMemfs(gitRepoFiles);

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Create job queue with the in-memory database
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue);

    // Create repository repository backed by in-memory SQLite
    repositoryRepository = new SqliteRepositoryRepository(getDatabase());

    // Pre-populate test repository BEFORE initializing the manager
    await repositoryRepository.save({
      id: testRepositoryId,
      name: 'test-repo',
      path: testRepoPath,
      createdAt: new Date().toISOString(),
    });

    // Create repository manager (will load the pre-created repository)
    const repositoryManager = await RepositoryManager.create({
      repository: repositoryRepository,
      jobQueue: testJobQueue,
    });

    // Create notification manager
    const notificationManager = new NotificationManager(new SlackHandler());

    // Create app with API routes
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', {
        repositoryManager,
        notificationManager,
      } as unknown as AppContext);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  // ===========================================================================
  // GET /api/settings/notifications/status
  // ===========================================================================

  describe('GET /api/settings/notifications/status', () => {
    it('should return notification status with baseUrl', async () => {
      const res = await app.request('/api/settings/notifications/status');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { baseUrl: string; isBaseUrlConfigured: boolean };
      expect(body.baseUrl).toBeDefined();
      expect(typeof body.isBaseUrlConfigured).toBe('boolean');
    });
  });

  // ===========================================================================
  // POST /api/repositories/:id/integrations/slack/test
  // ===========================================================================

  describe('POST /api/repositories/:id/integrations/slack/test', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    it('should send test notification and return success', async () => {
      // Create Slack integration for the test repository
      await upsertRepositorySlackIntegration(testRepositoryId, testWebhookUrl, true);

      // Mock the Slack webhook response
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack/test`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify the Slack webhook was called
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(testWebhookUrl);
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');

      // Verify the message content
      const messageBody = JSON.parse(options.body as string);
      expect(messageBody.text).toContain('Test notification');
    });

    it('should return error for non-existent repository', async () => {
      const res = await app.request('/api/repositories/non-existent-repo/integrations/slack/test', {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });

    it('should return error when Slack integration is not configured', async () => {
      // Repository exists but no Slack integration
      const res = await app.request(`/api/repositories/${testRepositoryId}/integrations/slack/test`, {
        method: 'POST',
      });

      expect(res.status).toBe(500);
    });
  });
});
