/**
 * Tests for SessionPage handleWorkerRestart logic.
 *
 * SessionPage cannot be rendered in unit tests due to complex dependencies
 * (xterm.js, WebSocket, TanStack Router). Instead, we model the
 * handleWorkerRestart state machine as pure functions and test the logic
 * independently, following the same pattern as Terminal.test.tsx.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Session, Worker } from '@agent-console/shared';

/**
 * Mirrors the PageState type in SessionPage.tsx.
 */
type PageState =
  | { type: 'loading' }
  | { type: 'active'; session: Session }
  | { type: 'disconnected'; session: Session }
  | { type: 'not_found' }
  | { type: 'server_unavailable' }
  | { type: 'restarting' }
  | { type: 'paused'; session: Session };

/**
 * Models the handleWorkerRestart logic from SessionPage.tsx (lines 251-281).
 *
 * This function reproduces the exact behavior:
 * 1. Extract session from state (only active/disconnected)
 * 2. Find agent worker
 * 3. Call restartAgentWorker API
 * 4. Reload session via getSession API and update state
 */
async function simulateHandleWorkerRestart(params: {
  state: PageState;
  sessionId: string;
  continueConversation: boolean;
  restartAgentWorker: (sessionId: string, workerId: string, continueConversation: boolean) => Promise<{ worker: Worker }>;
  getSession: (sessionId: string) => Promise<Session | null>;
  showError: (title: string, message: string) => void;
  updateTabsFromSession: (workers: Worker[]) => void;
}): Promise<PageState> {
  const { state, sessionId, continueConversation, restartAgentWorker, getSession, showError, updateTabsFromSession } = params;

  // Step 1: Extract session from state
  const session = (state.type === 'active' || state.type === 'disconnected') ? state.session : null;
  if (!session) return state;

  // Step 2: Find agent worker
  const agentWorker = session.workers.find(w => w.type === 'agent');
  if (!agentWorker) {
    showError('Restart Failed', 'No agent worker found in session');
    return state;
  }

  try {
    // Step 3: Call restart API
    await restartAgentWorker(sessionId, agentWorker.id, continueConversation);

    // Step 4: Reload session
    const updatedSession = await getSession(sessionId);
    if (!updatedSession) {
      return { type: 'not_found' };
    }
    if (updatedSession.status === 'active') {
      updateTabsFromSession([]);
      return { type: 'active', session: updatedSession };
    }
    return { type: 'disconnected', session: updatedSession };
  } catch (error) {
    showError('Restart Failed', error instanceof Error ? error.message : 'Failed to restart session');
    return { type: 'disconnected', session };
  }
}

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
    return simulateHandleWorkerRestart({
      state: overrides.state ?? { type: 'active', session: createMockSession() },
      sessionId: overrides.sessionId ?? 'session-1',
      continueConversation: overrides.continueConversation ?? true,
      restartAgentWorker: mockRestartAgentWorker,
      getSession: mockGetSession,
      showError: mockShowError,
      updateTabsFromSession: mockUpdateTabsFromSession,
    });
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
