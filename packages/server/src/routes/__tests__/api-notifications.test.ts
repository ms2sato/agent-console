import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import {
  shutdownNotificationServices,
  upsertRepositorySlackIntegration,
  setNotificationManager,
} from '../../services/notifications/index.js';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from '../../__tests__/utils/mock-fs-helper.js';
import { resetRepositoryManager, setRepositoryManager } from '../../services/repository-manager.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import { createTestContext, shutdownAppContext } from '../../app-context.js';

describe('Notifications API', () => {
  let app: Hono<AppBindings>;
  let appContext: AppContext;
  let testRepositoryId: string;
  const testRepoPath = '/test/path/to/repo';
  const testWebhookUrl = 'https://hooks.slack.com/services/T00/B00/xxx';

  beforeEach(async () => {
    // Reset singletons to ensure clean state
    resetRepositoryManager();
    shutdownNotificationServices();

    // Setup memfs with mock git repository structure
    const gitRepoFiles = createMockGitRepoFiles(testRepoPath);
    setupMemfs(gitRepoFiles);

    appContext = await createTestContext();
    setRepositoryManager(appContext.repositoryManager);
    setNotificationManager(appContext.notificationManager);

    // Register test repository so the repository manager has it in memory
    const repo = await appContext.repositoryManager.registerRepository(testRepoPath);
    testRepositoryId = repo.id;

    // Create app with API routes
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', appContext);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    // Shutdown services
    await shutdownAppContext(appContext, { resetSingletons: true });
    shutdownNotificationServices();
    resetRepositoryManager();
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
      await upsertRepositorySlackIntegration(testRepositoryId, testWebhookUrl, true, appContext.db);

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
