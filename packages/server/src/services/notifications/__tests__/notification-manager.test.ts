import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { AgentActivityState, NotificationContext, RepositorySlackIntegration } from '@agent-console/shared';

// Mock the logger to avoid noise in tests
mock.module('../../lib/logger.js', () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock repository integration lookup function - will be configured per test
let mockGetByRepositoryId: (_id: string) => Promise<RepositorySlackIntegration | null> = () => Promise.resolve(null);

mock.module('../repository-slack-integration-service.js', () => ({
  getByRepositoryId: (id: string) => mockGetByRepositoryId(id),
}));

describe('NotificationManager', () => {
  let importCounter = 0;

  // Reset the mock before each test
  beforeEach(() => {
    mockGetByRepositoryId = () => Promise.resolve(null);
  });

  // Mock SlackHandler with proper typing - using new interface
  function createMockSlackHandler() {
    const canHandleMock = mock((_repositoryId: string) => Promise.resolve(true));
    const sendMock = mock((_context: NotificationContext, _repositoryId: string) => Promise.resolve());
    const sendTestMock = mock((_message: string, _repositoryId: string) => Promise.resolve());
    return {
      integrationType: 'slack' as const,
      canHandle: canHandleMock,
      send: sendMock,
      sendTest: sendTestMock,
      sendToWebhook: mock((_context: NotificationContext, _webhookUrl: string) => Promise.resolve()),
      _canHandleMock: canHandleMock,
      _sendMock: sendMock,
      _sendTestMock: sendTestMock,
    };
  }

  // Helper to get NotificationManager with mocked dependencies
  // Optionally override private methods for testing with custom debounce/trigger settings
  async function getNotificationManager(
    slackHandler = createMockSlackHandler(),
    options?: {
      debounceSeconds?: number;
      triggers?: Record<string, boolean>;
      baseUrl?: string;
    }
  ) {
    // Import fresh module
    const module = await import(`../notification-manager.js?v=${++importCounter}`);

    // Create the manager with mock slack handler
    const manager = new module.NotificationManager(slackHandler as unknown as import('../slack-handler.js').SlackHandler);

    // Override private methods if options provided (for testing)
    if (options?.debounceSeconds !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).getDebounceSeconds = () => options.debounceSeconds;
    }
    if (options?.triggers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).isTriggerEnabled = (eventType: string) => options.triggers![eventType] ?? false;
    }
    if (options?.baseUrl !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).getBaseUrl = () => options.baseUrl;
    }

    return { manager, slackHandler };
  }

  // Test session and worker info
  const testSession = {
    id: 'session-1',
    title: 'Test Session',
    worktreeId: 'feature-branch',
    repositoryId: 'test-repo-1',  // Required for Slack notifications
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

  // Helper to set up mock for repository integration
  function setupMockIntegration(integration: RepositorySlackIntegration | null = defaultRepoIntegration) {
    mockGetByRepositoryId = (id: string) => {
      if (integration && id === integration.repositoryId) {
        return Promise.resolve(integration);
      }
      return Promise.resolve(null);
    };
  }

  describe('activity state mapping', () => {
    it('should map "asking" activity state to "agent:waiting" event', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.event.type).toBe('agent:waiting');

      manager.dispose();
    });

    it('should map "idle" activity state to "agent:idle" event', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.event.type).toBe('agent:idle');

      manager.dispose();
    });

    it('should map "active" activity state to "agent:active" event', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.event.type).toBe('agent:active');

      manager.dispose();
    });

    it('should not trigger notification for "unknown" activity state', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSession, testWorker, 'unknown' as AgentActivityState);

      // No wait needed since unknown state is filtered before any async operation
      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      manager.dispose();
    });
  });

  describe('state transition filtering', () => {
    it('should skip waiting -> idle transition (user action result)', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      // First, go to waiting state
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      expect(slackHandler._sendMock.mock.calls[0][0].event.type).toBe('agent:waiting');

      // Then transition to idle (user responded) - should NOT notify
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Still only 1 notification (the initial waiting)
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);

      manager.dispose();
    });

    it('should send active -> idle transition (work completed)', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      // First, go to active state
      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      expect(slackHandler._sendMock.mock.calls[0][0].event.type).toBe('agent:active');

      // Then transition to idle (work completed) - SHOULD notify
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 2 notifications: active and idle
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(2);
      expect(slackHandler._sendMock.mock.calls[1][0].event.type).toBe('agent:idle');

      manager.dispose();
    });

    it('should still track state after skipping waiting -> idle', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      // waiting -> idle (skipped)
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1); // only waiting

      // Now go to waiting again - should notify (state changed from idle to waiting)
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slackHandler._sendMock).toHaveBeenCalledTimes(2);
      expect(slackHandler._sendMock.mock.calls[1][0].event.type).toBe('agent:waiting');

      manager.dispose();
    });
  });

  describe('trigger rules filtering', () => {
    it('should not send notification when trigger is disabled', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
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

      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should send notification when trigger is enabled', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
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

      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);

      manager.dispose();
    });
  });

  describe('default trigger configuration', () => {
    // Tests using the actual default configuration
    it('should have agent:active disabled by default', async () => {
      setupMockIntegration();
      // Use the actual default settings (no overrides)
      const { manager, slackHandler } = await getNotificationManager();

      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);

      // Wait longer than default debounce (3 seconds) + buffer
      await new Promise(resolve => setTimeout(resolve, 3200));

      // agent:active is disabled by default, so no notification should be sent
      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should have agent:waiting enabled by default', async () => {
      setupMockIntegration();
      // Use the actual default settings (no overrides)
      const { manager, slackHandler } = await getNotificationManager();

      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait longer than default debounce (3 seconds) + buffer
      await new Promise(resolve => setTimeout(resolve, 3200));

      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      expect(slackHandler._sendMock.mock.calls[0][0].event.type).toBe('agent:waiting');

      manager.dispose();
    });
  });

  describe('debouncing per session:worker', () => {
    it('should debounce notifications independently for different session:worker pairs', async () => {
      // Set up mock to return integration for multiple repositories
      mockGetByRepositoryId = () => Promise.resolve(defaultRepoIntegration);

      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.05, // 50ms debounce
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      const session2 = { id: 'session-2', title: 'Session 2', worktreeId: 'branch-2', repositoryId: 'test-repo-1' };

      // Trigger notification for session-1
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Trigger notification for session-2 immediately after
      manager.onActivityChange(session2, testWorker, 'idle' as AgentActivityState);

      // Wait for debounce period to pass for both
      await new Promise(resolve => setTimeout(resolve, 100));

      // Both sessions should have sent notifications (debounce is independent per session:worker)
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(2);

      manager.dispose();
    });

    it('should coalesce rapid state changes for same session:worker into one notification', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.05, // 50ms debounce
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      // Rapid state changes for same session:worker
      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // Wait for debounce period to pass
      await new Promise(resolve => setTimeout(resolve, 100));

      // Only the last state should be sent
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.event.type).toBe('agent:waiting');

      manager.dispose();
    });
  });

  describe('debouncing behavior', () => {
    it('should debounce rapid state changes', async () => {
      setupMockIntegration();
      // Use very short debounce for testing with real timers
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.05, // 50ms
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      // Rapid state changes
      manager.onActivityChange(testSession, testWorker, 'active' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      manager.onActivityChange(testSession, testWorker, 'asking' as AgentActivityState);

      // No notification sent yet (waiting for debounce)
      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      // Wait for debounce period to pass
      await new Promise(resolve => setTimeout(resolve, 100));

      // Only the last state should be sent
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.event.type).toBe('agent:waiting');

      manager.dispose();
    });

    it('should send immediately when debounceSeconds is 0', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Wait for async notification sending (notification is sent without debounce, but still async)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should be sent immediately (no debounce delay)
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);

      manager.dispose();
    });
  });

  describe('URL building', () => {
    it('should build correct agentConsoleUrl format', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
        baseUrl: 'http://example.com:8080',
      });

      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);

      // Wait for async notification sending
      await new Promise(resolve => setTimeout(resolve, 50));

      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.agentConsoleUrl).toBe('http://example.com:8080/sessions/session-1?workerId=worker-1');

      manager.dispose();
    });
  });

  describe('worker events', () => {
    it('should send worker:error notification immediately without debouncing', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 10, // Long debounce that shouldn't apply
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onWorkerError(testSession, testWorker, 'Process crashed');

      // Wait for async notification sending (even though not debounced, still async)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should be sent immediately, not debounced
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.event.type).toBe('worker:error');
      expect((context.event as { message: string }).message).toBe('Process crashed');

      manager.dispose();
    });

    it('should send worker:exited notification immediately without debouncing', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 10, // Long debounce that shouldn't apply
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onWorkerExit(testSession, testWorker, 0);

      // Wait for async notification sending (even though not debounced, still async)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should be sent immediately, not debounced
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context] = slackHandler._sendMock.mock.calls[0];
      expect(context.event.type).toBe('worker:exited');
      expect((context.event as { exitCode: number }).exitCode).toBe(0);

      manager.dispose();
    });
  });

  describe('sendTestNotification', () => {
    it('should call slackHandler.sendTest with repositoryId', async () => {
      setupMockIntegration();
      const { manager, slackHandler } = await getNotificationManager();

      await manager.sendTestNotification('test-repo-1', 'Test message');

      expect(slackHandler._sendTestMock).toHaveBeenCalledWith('Test message', 'test-repo-1');

      manager.dispose();
    });
  });

  describe('dispose', () => {
    it('should clear all debounce timers on dispose', async () => {
      setupMockIntegration();
      // Use short debounce for testing with real timers
      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0.1, // 100ms
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      // Schedule a debounced notification
      manager.onActivityChange(testSession, testWorker, 'idle' as AgentActivityState);
      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      // Dispose before debounce completes
      manager.dispose();

      // Wait for what would have been after the debounce period
      await new Promise(resolve => setTimeout(resolve, 150));

      // Notification should NOT be sent after dispose
      expect(slackHandler._sendMock).not.toHaveBeenCalled();
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
      // Configure mock to return repository integration
      mockGetByRepositoryId = (id: string) => {
        if (id === 'repo-123') {
          return Promise.resolve(repoSlackIntegration);
        }
        return Promise.resolve(null);
      };

      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSessionWithDifferentRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should use canHandle first
      expect(slackHandler._canHandleMock).toHaveBeenCalledWith('repo-123');

      // Should use send with repositoryId
      expect(slackHandler._sendMock).toHaveBeenCalledTimes(1);
      const [context, repositoryId] = slackHandler._sendMock.mock.calls[0];
      expect(context.session.id).toBe('session-1');
      expect(repositoryId).toBe('repo-123');

      manager.dispose();
    });

    it('should not send notification when canHandle returns false', async () => {
      // Create a mock where canHandle returns false
      const mockSlackHandler = createMockSlackHandler();
      mockSlackHandler._canHandleMock.mockResolvedValue(false);

      const { manager, slackHandler } = await getNotificationManager(mockSlackHandler, {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSessionWithDifferentRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // canHandle should be called
      expect(slackHandler._canHandleMock).toHaveBeenCalledWith('repo-123');

      // send should NOT be called when canHandle returns false
      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should not send notification for sessions without repositoryId', async () => {
      // testSessionWithoutRepo has no repositoryId
      mockGetByRepositoryId = () => Promise.resolve(null);

      const { manager, slackHandler } = await getNotificationManager(createMockSlackHandler(), {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSessionWithoutRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not call canHandle or send for sessions without repository
      expect(slackHandler._canHandleMock).not.toHaveBeenCalled();
      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('should handle canHandle error gracefully', async () => {
      // Create a mock where canHandle throws an error
      const mockSlackHandler = createMockSlackHandler();
      mockSlackHandler._canHandleMock.mockRejectedValue(new Error('Database error'));

      const { manager, slackHandler } = await getNotificationManager(mockSlackHandler, {
        debounceSeconds: 0,
        triggers: { 'agent:waiting': true, 'agent:idle': true, 'agent:active': true, 'worker:error': true, 'worker:exited': true },
      });

      manager.onActivityChange(testSessionWithDifferentRepo, testWorker, 'idle' as AgentActivityState);

      // Wait for async sendSlackNotification to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not send notification when canHandle fails
      expect(slackHandler._sendMock).not.toHaveBeenCalled();

      manager.dispose();
    });
  });
});
