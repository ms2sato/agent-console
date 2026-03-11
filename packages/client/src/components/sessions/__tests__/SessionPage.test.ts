/**
 * Tests for SessionPage logic that remains in SessionPage.tsx.
 *
 * State management tests (sessions-sync, session-paused, etc.) have been moved
 * to useSessionPageState.test.ts which tests the actual production hook.
 *
 * This file tests:
 * - sessionToPageState (pure function, re-exported from SessionPage)
 * - handleWorkerRestart (extracted pure function in sessionPageActions)
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Session, Worker } from '@agent-console/shared';
import { sessionToPageState, type PageState } from '../SessionPage';
import { handleWorkerRestart } from '../sessionPageActions';

// Test helpers

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    type: 'worktree',
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'feat/test',
    isMainWorktree: false,
    locationPath: '/path/to/worktree',
    status: 'active',
    activationState: 'running',
    createdAt: new Date().toISOString(),
    workers: [
      { id: 'agent-worker-1', type: 'agent', name: 'Claude Code', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
      { id: 'terminal-worker-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
    ],
    ...overrides,
  } as Session;
}

describe('SessionPage handleWorkerRestart logic', () => {
  let mockRestartAgentWorker: ReturnType<typeof mock>;
  let mockGetSession: ReturnType<typeof mock>;
  let mockShowError: ReturnType<typeof mock>;
  let mockUpdateTabsFromSession: ReturnType<typeof mock>;

  beforeEach(() => {
    mockRestartAgentWorker = mock(() => Promise.resolve({ worker: { id: 'agent-worker-1' } }));
    mockGetSession = mock(() => Promise.resolve(createMockSession()));
    mockShowError = mock(() => {});
    mockUpdateTabsFromSession = mock(() => {});
  });

  function callRestart(overrides: {
    state?: PageState;
    sessionId?: string;
    continueConversation?: boolean;
  } = {}): Promise<PageState> {
    return handleWorkerRestart(
      overrides.state ?? { type: 'active', session: createMockSession() },
      overrides.sessionId ?? 'session-1',
      overrides.continueConversation ?? true,
      {
        restartAgentWorker: mockRestartAgentWorker,
        getSession: mockGetSession,
        showError: mockShowError,
        updateTabsFromSession: mockUpdateTabsFromSession,
      },
    );
  }

  describe('restart with continue flag', () => {
    it('should call restartAgentWorker with continueConversation=true', async () => {
      await callRestart({ continueConversation: true });

      expect(mockRestartAgentWorker).toHaveBeenCalledTimes(1);
      expect(mockRestartAgentWorker.mock.calls[0]).toEqual(['session-1', 'agent-worker-1', true]);
    });

    it('should call restartAgentWorker with continueConversation=false', async () => {
      await callRestart({ continueConversation: false });

      expect(mockRestartAgentWorker).toHaveBeenCalledTimes(1);
      expect(mockRestartAgentWorker.mock.calls[0]).toEqual(['session-1', 'agent-worker-1', false]);
    });
  });

  describe('state transitions on success', () => {
    it('should transition to active state when updated session is active', async () => {
      const updatedSession = createMockSession({ status: 'active' });
      mockGetSession.mockReturnValue(Promise.resolve(updatedSession));

      const result = await callRestart();

      expect(result.type).toBe('active');
      if (result.type === 'active') {
        expect(result.session).toBe(updatedSession);
      }
      expect(mockUpdateTabsFromSession).toHaveBeenCalledWith([]);
    });

    it('should transition to disconnected state when updated session is inactive', async () => {
      const updatedSession = createMockSession({ status: 'inactive' });
      mockGetSession.mockReturnValue(Promise.resolve(updatedSession));

      const result = await callRestart();

      expect(result.type).toBe('disconnected');
      if (result.type === 'disconnected') {
        expect(result.session).toBe(updatedSession);
      }
    });

    it('should transition to not_found when session no longer exists after restart', async () => {
      mockGetSession.mockReturnValue(Promise.resolve(null));

      const result = await callRestart();

      expect(result.type).toBe('not_found');
    });
  });

  describe('works from disconnected state', () => {
    it('should restart from disconnected state same as active', async () => {
      const session = createMockSession({ status: 'inactive' });
      const updatedSession = createMockSession({ status: 'active' });
      mockGetSession.mockReturnValue(Promise.resolve(updatedSession));

      const result = await callRestart({
        state: { type: 'disconnected', session },
      });

      expect(mockRestartAgentWorker).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('active');
    });
  });

  describe('error when no agent worker found', () => {
    it('should show error and return original state when session has no agent workers', async () => {
      const session = createMockSession({
        workers: [
          { id: 'terminal-worker-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
        ] as Worker[],
      });
      const state: PageState = { type: 'active', session };

      const result = await callRestart({ state });

      expect(mockShowError).toHaveBeenCalledTimes(1);
      expect(mockShowError).toHaveBeenCalledWith('Restart Failed', 'No agent worker found in session');
      expect(mockRestartAgentWorker).not.toHaveBeenCalled();
      expect(result).toBe(state);
    });
  });

  describe('no-op for invalid states', () => {
    it('should return original state when state is loading', async () => {
      const state: PageState = { type: 'loading' };

      const result = await callRestart({ state });

      expect(result).toBe(state);
      expect(mockRestartAgentWorker).not.toHaveBeenCalled();
    });

    it('should return original state when state is paused', async () => {
      const state: PageState = { type: 'paused', session: createMockSession() };

      const result = await callRestart({ state });

      expect(result).toBe(state);
      expect(mockRestartAgentWorker).not.toHaveBeenCalled();
    });

    it('should return original state when state is not_found', async () => {
      const state: PageState = { type: 'not_found' };

      const result = await callRestart({ state });

      expect(result).toBe(state);
      expect(mockRestartAgentWorker).not.toHaveBeenCalled();
    });

    it('should return original state when state is server_unavailable', async () => {
      const state: PageState = { type: 'server_unavailable' };

      const result = await callRestart({ state });

      expect(result).toBe(state);
      expect(mockRestartAgentWorker).not.toHaveBeenCalled();
    });

    it('should return original state when state is restarting', async () => {
      const state: PageState = { type: 'restarting' };

      const result = await callRestart({ state });

      expect(result).toBe(state);
      expect(mockRestartAgentWorker).not.toHaveBeenCalled();
    });
  });

  describe('API failure handling', () => {
    it('should show error notification and revert to disconnected state when API call fails', async () => {
      const session = createMockSession();
      mockRestartAgentWorker.mockReturnValue(Promise.reject(new Error('Network error: server unreachable')));

      const result = await callRestart({
        state: { type: 'active', session },
      });

      expect(mockShowError).toHaveBeenCalledTimes(1);
      expect(mockShowError).toHaveBeenCalledWith('Restart Failed', 'Network error: server unreachable');
      expect(result.type).toBe('disconnected');
      if (result.type === 'disconnected') {
        expect(result.session).toBe(session);
      }
    });

    it('should handle non-Error exceptions in API failure', async () => {
      mockRestartAgentWorker.mockReturnValue(Promise.reject('string error'));

      const result = await callRestart();

      expect(mockShowError).toHaveBeenCalledWith('Restart Failed', 'Failed to restart session');
      expect(result.type).toBe('disconnected');
    });

    it('should show error and revert when getSession fails after successful restart', async () => {
      mockGetSession.mockReturnValue(Promise.reject(new Error('Failed to reload session')));

      const result = await callRestart();

      expect(mockRestartAgentWorker).toHaveBeenCalledTimes(1);
      expect(mockShowError).toHaveBeenCalledWith('Restart Failed', 'Failed to reload session');
      expect(result.type).toBe('disconnected');
    });
  });

  describe('first agent worker selection', () => {
    it('should use the first agent worker when session has multiple workers', async () => {
      const session = createMockSession({
        workers: [
          { id: 'terminal-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
          { id: 'agent-1', type: 'agent', name: 'Claude Code 1', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
          { id: 'agent-2', type: 'agent', name: 'Claude Code 2', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
        ] as Worker[],
      });

      await callRestart({ state: { type: 'active', session } });

      // Should use the first agent worker (agent-1), not terminal-1 or agent-2
      expect(mockRestartAgentWorker.mock.calls[0][1]).toBe('agent-1');
    });
  });
});

describe('sessionToPageState', () => {
  it('should return paused when session has pausedAt', () => {
    const session = createMockSession({ status: 'active', pausedAt: '2026-01-01T00:00:00Z' });

    const result = sessionToPageState(session);

    expect(result.type).toBe('paused');
    expect(result.session).toBe(session);
  });

  it('should return paused when session is inactive with pausedAt', () => {
    const session = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' });

    const result = sessionToPageState(session);

    expect(result.type).toBe('paused');
  });

  it('should return active when session status is active and no pausedAt', () => {
    const session = createMockSession({ status: 'active' });

    const result = sessionToPageState(session);

    expect(result.type).toBe('active');
    expect(result.session).toBe(session);
  });

  it('should return disconnected when session status is inactive and no pausedAt', () => {
    const session = createMockSession({ status: 'inactive' });

    const result = sessionToPageState(session);

    expect(result.type).toBe('disconnected');
    expect(result.session).toBe(session);
  });

  it('should prioritize pausedAt over active status', () => {
    // Edge case: session has both status='active' and pausedAt set
    const session = createMockSession({ status: 'active', pausedAt: '2026-01-01T00:00:00Z' });

    const result = sessionToPageState(session);

    // pausedAt takes precedence
    expect(result.type).toBe('paused');
  });
});
