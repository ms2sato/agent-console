import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import { initializeNotificationServices, shutdownNotificationServices } from '../../services/notifications/index.js';
import { setupTestConfigDir, cleanupTestConfigDir } from '../../__tests__/utils/mock-fs-helper.js';

describe('Notifications API', () => {
  let app: Hono;
  const testConfigPath = '/test/notification-api-config';

  beforeEach(() => {
    // Setup memfs config directory
    setupTestConfigDir(testConfigPath);

    // Initialize notification services
    shutdownNotificationServices();
    initializeNotificationServices();

    // Create app with API routes
    app = new Hono();
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(() => {
    // Shutdown notification services
    shutdownNotificationServices();

    // Cleanup memfs
    cleanupTestConfigDir();
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

    it('should return error for non-existent repository', async () => {
      const res = await app.request('/api/repositories/non-existent-repo/integrations/slack/test', {
        method: 'POST',
      });
      // Returns 404 (not found) or 500 (error getting repository manager)
      expect([404, 500].includes(res.status)).toBe(true);
    });

    // Note: Full integration test for sending test notifications would require:
    // 1. Creating a real git repository
    // 2. Registering it with the repository manager
    // 3. Configuring Slack integration
    // This is better suited for an integration test rather than unit test.
  });
});
