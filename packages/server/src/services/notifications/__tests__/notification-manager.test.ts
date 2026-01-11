import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AgentActivityState, NotificationContext, RepositorySlackIntegration, OutboundTriggerEventType } from '@agent-console/shared';
import { initializeDatabase, closeDatabase, getDatabase } from '../../../database/connection.js';
import * as repoSlackIntegrationService from '../repository-slack-integration-service.js';
import { NotificationManager, type NotificationManagerOptions } from '../notification-manager.js';
import type { SlackHandler } from '../slack-handler.js';

describe('NotificationManager', () => {
  // Mock SlackHandler with proper typing
  function createMockSlackHandler() {
    return {
      integrationType: 'slack' as const,
      canHandle: mock((_repositoryId: string) => Promise.resolve(true)),
      send: mock((_context: NotificationContext, _repositoryId: string) => Promise.resolve()),
      sendTest: mock((_message: string, _repositoryId: string) => Promise.resolve()),
      sendToWebhook: mock((_context: NotificationContext, _webhookUrl: string) => Promise.resolve()),
    };
  }

  type MockSlackHandler = ReturnType<typeof createMockSlackHandler>;

  // Helper to create NotificationManager with mock SlackHandler
  function createNotificationManager(
    slackHandler: MockSlackHandler = createMockSlackHandler(),
    options?: NotificationManagerOptions
  ) {
    const manager = new NotificationManager(
      slackHandler as unknown as SlackHandler,
      options
    );
    return { manager, slackHandler };
  }

  // All triggers enabled for testing
  const allTriggersEnabled: Record<OutboundTriggerEventType, boolean> = {
    'agent:waiting': true,
    'agent:idle': true,
    'agent:active': true,
    'worker:error': true,
    'worker:exited': true,
  };

  // Test session and worker info
  const testSession = {
    id: 'session-1',
    title: 'Test Session',
    worktreeId: 'feature-branch',
    repositoryId: 'test-repo-1',
  };

  const testWorker = {
    id: 'worker-1',
  };

  // Default repository Slack integration for tests
  const defaultRepoIntegration: RepositorySlackIntegration = {
    id: 'integration-1',
    repositoryId: 'test-repo-1',
    webhookUrl: 'https://hooks.slack.com/services/T00/B00/test',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Helper to create the parent repository record (required due to foreign key constraint)
  async function createTestRepository(repositoryId: string) {
    const db = getDatabase();
    const now = new Date().toISOString();
    // Use ON CONFLICT to avoid duplicate key errors when called multiple times
    await db.insertInto('repositories').values({
      id: repositoryId,
      name: 'test-repo',
      path: `/test/path/to/${repositoryId}`,
      created_at: now,
      updated_at: now,
    }).onConflict((oc) => oc.column('id').doNothing()).execute();
  }

  beforeEach(async () => {
    // Initialize in-memory database for each test
    await initializeDatabase(':memory:');
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // Helper to set up repository integration in the real database
  async function setupRepoIntegration(integration: RepositorySlackIntegration = defaultRepoIntegration) {
    // Create parent repository first
    await createTestRepository(integration.repositoryId);
    await repoSlackIntegrationService.create(
      integration.repositoryId,
      integration.webhookUrl,
      integration.enabled
    );
  }

  describe('activity state mapping', () => {
    it('should map "asking" activity state to "agent:waiting" event', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context] = slackHandler.send.mock.calls[0];
      expect(context.event.type).toBe('agent:waiting');

      manager.dispose();
    });

    it('should map "idle" activity state to "agent:idle" event', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context] = slackHandler.send.mock.calls[0];
      expect(context.event.type).toBe('agent:idle');

      manager.dispose();
    });

    it('should map "active" activity state to "agent:active" event', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context] = slackHandler.send.mock.calls[0];
      expect(context.event.type).toBe('agent:active');

      manager.dispose();
    });

    it('should not trigger notification for "unknown" activity state', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSession, testWorker, 'unknown' as AgentActivityState);

      // No wait needed since unknown state is filtered before any async operation
      expect(slackHandler.send).not.toHaveBeenCalled();

      manager.dispose();
    });
  });

  describe('state transition filtering', () => {
    it('should skip waiting -> idle transition (user action result)', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      // First, go to waiting state
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      expect(slackHandler.send.mock.calls[0][0].event.type).toBe('agent:waiting');

      // Then transition to idle (user responded) - should NOT notify
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Still only 1 notification (the initial waiting)
      expect(slackHandler.send).toHaveBeenCalledTimes(1);

      manager.dispose();
    });

    it('should send active -> idle transition (work completed)', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      // First, go to active state
      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      expect(slackHandler.send.mock.calls[0][0].event.type).toBe('agent:active');

      // Then transition to idle (work completed) - SHOULD notify
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 2 notifications: active and idle
      expect(slackHandler.send).toHaveBeenCalledTimes(2);
      expect(slackHandler.send.mock.calls[1][0].event.type).toBe('agent:idle');

      manager.dispose();
    });

    it('should still track state after skipping waiting -> idle', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      // waiting -> idle (skipped)
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).toHaveBeenCalledTimes(1); // only waiting

      // Now go to waiting again - should notify (state changed from idle to waiting)
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).toHaveBeenCalledTimes(2);
      expect(slackHandler.send.mock.calls[1][0].event.type).toBe('agent:waiting');

      manager.dispose();
    });
  });

  describe('trigger rules filtering', () => {
    it('should not send notification when trigger is disabled', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: {
          'agent:waiting': false, // disabled
          'agent:idle': true,
          'agent:active': false,
          'worker:error': true,
          'worker:exited': false,
        },
      });

      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait a bit for async operations (though none should happen since trigger is disabled)
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should send notification when trigger is enabled', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: {
          'agent:waiting': true, // enabled
          'agent:idle': true,
          'agent:active': false,
          'worker:error': true,
          'worker:exited': false,
        },
      });

      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).toHaveBeenCalledTimes(1);

      manager.dispose();
    });
  });

  describe('default trigger configuration', () => {
    // Tests using the actual default configuration
    it('should have agent:active disabled by default', async () => {
      await setupRepoIntegration();
      // Use the actual default settings (no trigger overrides, but set debounce for faster test)
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0, // Override debounce for faster test
        // triggers not set - uses DEFAULT_TRIGGERS
      });

      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      // agent:active is disabled by default, so no notification should be sent
      expect(slackHandler.send).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should have agent:waiting enabled by default', async () => {
      await setupRepoIntegration();
      // Use the actual default settings (no trigger overrides, but set debounce for faster test)
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0, // Override debounce for faster test
        // triggers not set - uses DEFAULT_TRIGGERS
      });

      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      expect(slackHandler.send.mock.calls[0][0].event.type).toBe('agent:waiting');

      manager.dispose();
    });
  });

  describe('debouncing per session:worker', () => {
    it('should debounce notifications independently for different session:worker pairs', async () => {
      await setupRepoIntegration();

      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.05, // 50ms debounce
        triggers: allTriggersEnabled,
      });

      const session2 = { id: 'session-2', title: 'Session 2', worktreeId: 'branch-2', repositoryId: 'test-repo-1' };

      // Trigger notification for session-1
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Trigger notification for session-2 immediately after
      manager.onActivityChange(session2, testWorker, 'idle' as AgentActivityState);

      // Wait for debounce period to pass for both
      await new Promise(resolve => setTimeout(resolve, 100));

      // Both sessions should have sent notifications (debounce is independent per session:worker)
      expect(slackHandler.send).toHaveBeenCalledTimes(2);

      manager.dispose();
    });

    it('should coalesce rapid state changes for same session:worker into one notification', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.05, // 50ms debounce
        triggers: allTriggersEnabled,
      });

      // Rapid state changes for same session:worker
      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait for debounce period to pass
      await new Promise(resolve => setTimeout(resolve, 100));

      // Only the last state should be sent
      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context] = slackHandler.send.mock.calls[0];
      expect(context.event.type).toBe('agent:waiting');

      manager.dispose();
    });
  });

  describe('debouncing behavior', () => {
    it('should debounce rapid state changes', async () => {
      await setupRepoIntegration();
      // Use very short debounce for testing with real timers
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.05, // 50ms
        triggers: allTriggersEnabled,
      });

      // Rapid state changes
      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // No notification sent yet (waiting for debounce)
      expect(slackHandler.send).not.toHaveBeenCalled();

      // Wait for debounce period to pass
      await new Promise(resolve => setTimeout(resolve, 100));

      // Only the last state should be sent
      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context] = slackHandler.send.mock.calls[0];
      expect(context.event.type).toBe('agent:waiting');

      manager.dispose();
    });

    it('should send immediately when debounceSeconds is 0', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Wait for async notification sending (notification is sent without debounce, but still async)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should be sent immediately (no debounce delay)
      expect(slackHandler.send).toHaveBeenCalledTimes(1);

      manager.dispose();
    });
  });

  describe('URL building', () => {
    it('should build correct agentConsoleUrl format', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
        baseUrl: 'http://example.com:8080',
      });

      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      const [context] = slackHandler.send.mock.calls[0];
      expect(context.agentConsoleUrl).toBe('http://example.com:8080/sessions/session-1?workerId=worker-1');

      manager.dispose();
    });
  });

  describe('worker events', () => {
    it('should send worker:error notification immediately without debouncing', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 10, // Long debounce that shouldn't apply
        triggers: allTriggersEnabled,
      });

      manager.onWorkerError(testSession, testWorker, 'Process crashed');

      // Wait for async notification sending (even though not debounced, still async)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should be sent immediately, not debounced
      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context] = slackHandler.send.mock.calls[0];
      expect(context.event.type).toBe('worker:error');
      expect((context.event as { message: string }).message).toBe('Process crashed');

      manager.dispose();
    });

    it('should send worker:exited notification immediately without debouncing', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 10, // Long debounce that shouldn't apply
        triggers: allTriggersEnabled,
      });

      manager.onWorkerExit(testSession, testWorker, 0);

      // Wait for async notification sending (even though not debounced, still async)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should be sent immediately, not debounced
      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context] = slackHandler.send.mock.calls[0];
      expect(context.event.type).toBe('worker:exited');
      expect((context.event as { exitCode: number }).exitCode).toBe(0);

      manager.dispose();
    });
  });

  describe('sendTestNotification', () => {
    it('should call slackHandler.sendTest with repositoryId', async () => {
      await setupRepoIntegration();
      const { manager, slackHandler } = createNotificationManager();

      await manager.sendTestNotification('test-repo-1', 'Test message');

      expect(slackHandler.sendTest).toHaveBeenCalledWith('Test message', 'test-repo-1');

      manager.dispose();
    });
  });

  describe('dispose', () => {
    it('should clear all debounce timers on dispose', async () => {
      await setupRepoIntegration();
      // Use short debounce for testing with real timers
      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.1, // 100ms
        triggers: allTriggersEnabled,
      });

      // Schedule a debounced notification
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      expect(slackHandler.send).not.toHaveBeenCalled();

      // Dispose before debounce completes
      manager.dispose();

      // Wait for what would have been after the debounce period
      await new Promise(resolve => setTimeout(resolve, 150));

      // Notification should NOT be sent after dispose
      expect(slackHandler.send).not.toHaveBeenCalled();
    });
  });

  describe('repository-level Slack integration', () => {
    // Session with a different repository for testing repository-level config
    const testSessionWithDifferentRepo = {
      id: 'session-1',
      title: 'Test Session',
      worktreeId: 'feature-branch',
      repositoryId: 'repo-123',
    };

    // Session without repositoryId for testing the no-repo case
    const testSessionWithoutRepo = {
      id: 'session-no-repo',
      title: 'No Repo Session',
      worktreeId: 'feature-branch',
    };

    const repoSlackIntegration: RepositorySlackIntegration = {
      id: 'integration-1',
      repositoryId: 'repo-123',
      webhookUrl: 'https://hooks.slack.com/services/repo-specific',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('should use canHandle and send methods when repository has integration', async () => {
      // Create parent repository first
      await createTestRepository(repoSlackIntegration.repositoryId);
      // Configure repository integration in the real database
      await repoSlackIntegrationService.create(
        repoSlackIntegration.repositoryId,
        repoSlackIntegration.webhookUrl,
        repoSlackIntegration.enabled
      );

      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSessionWithDifferentRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should use canHandle first
      expect(slackHandler.canHandle).toHaveBeenCalledWith('repo-123');

      // Should use send with repositoryId
      expect(slackHandler.send).toHaveBeenCalledTimes(1);
      const [context, repositoryId] = slackHandler.send.mock.calls[0];
      expect(context.session.id).toBe('session-1');
      expect(repositoryId).toBe('repo-123');

      manager.dispose();
    });

    it('should not send notification when canHandle returns false', async () => {
      // Create a mock where canHandle returns false
      const mockSlackHandler = createMockSlackHandler();
      mockSlackHandler.canHandle.mockResolvedValue(false);

      const { manager, slackHandler } = createNotificationManager(mockSlackHandler, {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSessionWithDifferentRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // canHandle should be called
      expect(slackHandler.canHandle).toHaveBeenCalledWith('repo-123');

      // send should NOT be called when canHandle returns false
      expect(slackHandler.send).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should not send notification for sessions without repositoryId', async () => {
      // testSessionWithoutRepo has no repositoryId

      const { manager, slackHandler } = createNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSessionWithoutRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not call canHandle or send for sessions without repository
      expect(slackHandler.canHandle).not.toHaveBeenCalled();
      expect(slackHandler.send).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should handle canHandle error gracefully', async () => {
      // Create a mock where canHandle throws an error
      const mockSlackHandler = createMockSlackHandler();
      mockSlackHandler.canHandle.mockRejectedValue(new Error('Database error'));

      const { manager, slackHandler } = createNotificationManager(mockSlackHandler, {
        debounceSeconds: 0,
        triggers: allTriggersEnabled,
      });

      manager.onActivityChange(testSessionWithDifferentRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not send notification when canHandle fails
      expect(slackHandler.send).not.toHaveBeenCalled();

      manager.dispose();
    });
  });
});
