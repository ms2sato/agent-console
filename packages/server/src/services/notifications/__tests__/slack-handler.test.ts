import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { NotificationContext } from '@agent-console/shared';
import { initializeDatabase, closeDatabase, getDatabase } from '../../../database/connection.js';
import * as repoSlackIntegrationService from '../repository-slack-integration-service.js';
import { SlackHandler } from '../slack-handler.js';

describe('SlackHandler', () => {
  let handler: SlackHandler;

  // Helper to create a test notification context
  function createTestContext(
    eventType: NotificationContext['event']['type'],
    overrides: Partial<NotificationContext> = {}
  ): NotificationContext {
    const baseContext: NotificationContext = {
      session: {
        id: 'test-session-id',
        title: 'Test Session',
        worktreeId: 'feature-branch',
      },
      worker: {
        id: 'test-worker-id',
      },
      event: createEvent(eventType),
      agentConsoleUrl: 'http://localhost:5555/sessions/test-session-id?workerId=test-worker-id',
    };

    return { ...baseContext, ...overrides };
  }

  // Helper to create events by type
  function createEvent(type: NotificationContext['event']['type']): NotificationContext['event'] {
    switch (type) {
      case 'agent:waiting':
        return { type: 'agent:waiting', activityState: 'waiting', timestamp: '2025-01-01T00:00:00Z' };
      case 'agent:idle':
        return { type: 'agent:idle', activityState: 'idle', timestamp: '2025-01-01T00:00:00Z' };
      case 'agent:active':
        return { type: 'agent:active', activityState: 'active', timestamp: '2025-01-01T00:00:00Z' };
      case 'worker:error':
        return { type: 'worker:error', message: 'Test error message', timestamp: '2025-01-01T00:00:00Z' };
      case 'worker:exited':
        return { type: 'worker:exited', exitCode: 1, timestamp: '2025-01-01T00:00:00Z' };
    }
  }

  const testWebhookUrl = 'https://hooks.slack.com/services/T00/B00/xxx';
  const testRepositoryId = 'test-repo-123';

  // Helper to create the parent repository record (required due to foreign key constraint)
  async function createTestRepository(repositoryId: string = testRepositoryId) {
    const db = getDatabase();
    const now = new Date().toISOString();
    await db.insertInto('repositories').values({
      id: repositoryId,
      name: 'test-repo',
      path: '/test/path/to/repo',
      created_at: now,
      updated_at: now,
    }).execute();
  }

  beforeEach(async () => {
    // Initialize in-memory database for each test
    await initializeDatabase(':memory:');
    handler = new SlackHandler();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  describe('initialization', () => {
    it('should initialize without errors', () => {
      expect(handler.integrationType).toBe('slack');
    });
  });

  describe('canHandle', () => {
    it('should return true when repository has enabled Slack integration', async () => {
      // Create parent repository first
      await createTestRepository();
      // Create integration in the real database
      await repoSlackIntegrationService.create(
        testRepositoryId,
        testWebhookUrl,
        true
      );

      expect(await handler.canHandle(testRepositoryId)).toBe(true);
    });

    it('should return false when repository has no Slack integration', async () => {
      expect(await handler.canHandle('unknown-repo')).toBe(false);
    });

    it('should return false when Slack integration is disabled', async () => {
      // Create parent repository first
      await createTestRepository();
      // Create disabled integration
      await repoSlackIntegrationService.create(
        testRepositoryId,
        testWebhookUrl,
        false
      );

      expect(await handler.canHandle(testRepositoryId)).toBe(false);
    });
  });

  describe('send', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      // Create parent repository first
      await createTestRepository();
      // Create enabled integration
      await repoSlackIntegrationService.create(
        testRepositoryId,
        testWebhookUrl,
        true
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should send notification when repository has enabled Slack integration', async () => {
      const context = createTestContext('agent:idle');

      await handler.send(context, testRepositoryId);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(testWebhookUrl);
    });

    it('should throw error when repository has no Slack integration', async () => {
      const context = createTestContext('agent:idle');

      await expect(handler.send(context, 'unknown-repo')).rejects.toThrow(
        'Slack integration not configured or disabled'
      );
    });

    it('should throw error when Slack integration is disabled', async () => {
      // Update to disabled
      await repoSlackIntegrationService.update(testRepositoryId, testWebhookUrl, false);

      const context = createTestContext('agent:idle');

      await expect(handler.send(context, testRepositoryId)).rejects.toThrow(
        'Slack integration not configured or disabled'
      );
    });
  });

  describe('sendToWebhook', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should format agent:waiting event correctly', async () => {
      const context = createTestContext('agent:waiting');

      await handler.sendToWebhook(context, testWebhookUrl);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(testWebhookUrl);

      const body = JSON.parse(options.body as string);
      expect(body.text).toContain('Test Session');
      expect(body.text).toContain('is asking a question');
      expect(body.text).toContain(':question:');
      expect(body.blocks[0].accessory.url).toBe('http://localhost:5555/sessions/test-session-id?workerId=test-worker-id');
    });

    it('should format agent:idle event correctly', async () => {
      const context = createTestContext('agent:idle');

      await handler.sendToWebhook(context, testWebhookUrl);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.text).toContain('has finished');
      expect(body.text).toContain(':white_check_mark:');
    });

    it('should format agent:active event correctly', async () => {
      const context = createTestContext('agent:active');

      await handler.sendToWebhook(context, testWebhookUrl);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.text).toContain('is processing');
      expect(body.text).toContain(':hourglass:');
    });

    it('should format worker:error event correctly', async () => {
      const context = createTestContext('worker:error');

      await handler.sendToWebhook(context, testWebhookUrl);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.text).toContain('encountered an error');
      expect(body.text).toContain(':x:');
    });

    it('should format worker:exited event correctly', async () => {
      const context = createTestContext('worker:exited');

      await handler.sendToWebhook(context, testWebhookUrl);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.text).toContain('process exited');
      expect(body.text).toContain(':stop_sign:');
    });

    it('should use worktreeId as session name fallback when title is null', async () => {
      const context = createTestContext('agent:idle', {
        session: {
          id: 'session-1',
          title: null,
          worktreeId: 'feature-xyz',
        },
      });

      await handler.sendToWebhook(context, testWebhookUrl);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.text).toContain('feature-xyz');
    });

    it('should use "Quick Session" as fallback when both title and worktreeId are null', async () => {
      const context = createTestContext('agent:idle', {
        session: {
          id: 'session-1',
          title: null,
          worktreeId: null,
        },
      });

      await handler.sendToWebhook(context, testWebhookUrl);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.text).toContain('Quick Session');
    });
  });

  describe('HTTP error handling', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    it('should throw error on non-200 response', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Bad Request', { status: 400 })
      );

      const context = createTestContext('agent:idle');

      await expect(handler.sendToWebhook(context, testWebhookUrl)).rejects.toThrow('Slack API error: 400');
    });

    it('should include error text in exception message', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Invalid webhook URL', { status: 404 })
      );

      const context = createTestContext('agent:idle');

      await expect(handler.sendToWebhook(context, testWebhookUrl)).rejects.toThrow('Invalid webhook URL');
    });

    it('should handle error when reading response body fails', async () => {
      const mockResponse = new Response(null, { status: 500 });
      spyOn(mockResponse, 'text').mockRejectedValue(new Error('Network error'));
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

      const context = createTestContext('agent:idle');

      await expect(handler.sendToWebhook(context, testWebhookUrl)).rejects.toThrow('Slack API error: 500 - Unknown error');
    });
  });

  describe('sendTest', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      // Create parent repository first
      await createTestRepository();
      // Create enabled integration
      await repoSlackIntegrationService.create(
        testRepositoryId,
        testWebhookUrl,
        true
      );
    });

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    it('should send test notification with custom message', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      await handler.sendTest('Test message from Agent Console', testRepositoryId);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.text).toBe('Test message from Agent Console');
      expect(body.blocks[0].text.text).toBe('Test message from Agent Console');
    });

    it('should use webhook URL from repository integration', async () => {
      const customWebhookUrl = 'https://hooks.slack.com/services/CUSTOM/WEBHOOK/url';
      await repoSlackIntegrationService.update(testRepositoryId, customWebhookUrl, true);

      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      await handler.sendTest('Test', testRepositoryId);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(customWebhookUrl);
    });

    it('should throw error when repository has no Slack integration', async () => {
      await expect(handler.sendTest('Test message', 'unknown-repo')).rejects.toThrow(
        'Slack integration not configured or disabled'
      );
    });

    it('should throw error when Slack integration is disabled', async () => {
      await repoSlackIntegrationService.update(testRepositoryId, testWebhookUrl, false);

      await expect(handler.sendTest('Test message', testRepositoryId)).rejects.toThrow(
        'Slack integration not configured or disabled'
      );
    });

    it('should throw error on API failure', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401 })
      );

      await expect(handler.sendTest('Test message', testRepositoryId)).rejects.toThrow('Slack API error: 401');
    });
  });
});
