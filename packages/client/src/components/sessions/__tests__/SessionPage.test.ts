/**
 * Tests for SessionPage state machine logic.
 *
 * SessionPage cannot be rendered in unit tests due to complex dependencies
 * (xterm.js, WebSocket, TanStack Router). Instead, we model the
 * state machine as pure functions and test the logic independently,
 * following the same pattern as Terminal.test.tsx.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Session, Worker } from '@agent-console/shared';
import { sessionToPageState } from '../SessionPage';

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

/**
 * Models the sessions-sync reconciliation logic from SessionPage.tsx.
 *
 * When sessions-sync arrives (after WebSocket reconnects), SessionPage must
 * reconcile its local PageState with the fresh session data from the server.
 *
 * Returns:
 * - newState: The reconciled state
 * - needsRefetch: true if the session was not found in the sync list and REST fallback is needed
 */
function reconcileFromSync(
  prev: PageState,
  sessionId: string,
  syncedSessions: Session[],
): { newState: PageState; needsRefetch: boolean } {
  // Don't interrupt ongoing restart operations
  if (prev.type === 'restarting') {
    return { newState: prev, needsRefetch: false };
  }

  const session = syncedSessions.find(s => s.id === sessionId);
  if (!session) {
    // Session not in sync - need REST fallback
    return { newState: prev, needsRefetch: true };
  }

  return { newState: sessionToPageState(session), needsRefetch: false };
}

/**
 * Models the REST fallback reconciliation after sessions-sync when
 * the session was not found in the synced list.
 */
function reconcileFromFetchedSession(
  prev: PageState,
  fetchedSession: Session | null,
): PageState {
  if (prev.type === 'restarting' || prev.type === 'not_found') return prev;

  if (!fetchedSession) {
    return { type: 'not_found' };
  }
  return sessionToPageState(fetchedSession);
}

/**
 * Models the session-resumed reconciliation logic from SessionPage.tsx.
 */
function reconcileFromResume(
  prev: PageState,
  sessionId: string,
  resumedSession: Session,
): PageState {
  if (resumedSession.id !== sessionId) return prev;
  if (prev.type === 'restarting') return prev;
  return { type: 'active', session: resumedSession };
}

describe('SessionPage sessions-sync reconciliation', () => {
  const sessionId = 'session-1';

  describe('session found in sync - active', () => {
    it('should transition to active when synced session is active', () => {
      const session = createMockSession({ id: sessionId, status: 'active' });
      const prev: PageState = { type: 'disconnected', session: createMockSession({ id: sessionId, status: 'inactive' }) };

      const result = reconcileFromSync(prev, sessionId, [session]);

      expect(result.needsRefetch).toBe(false);
      expect(result.newState.type).toBe('active');
      if (result.newState.type === 'active') {
        expect(result.newState.session).toBe(session);
      }
    });

    it('should transition from loading to active', () => {
      const session = createMockSession({ id: sessionId, status: 'active' });
      const prev: PageState = { type: 'loading' };

      const result = reconcileFromSync(prev, sessionId, [session]);

      expect(result.newState.type).toBe('active');
    });
  });

  describe('session found in sync - paused', () => {
    it('should transition to paused when synced session has pausedAt', () => {
      const session = createMockSession({
        id: sessionId,
        status: 'inactive',
        pausedAt: '2026-01-01T00:00:00Z',
      });
      const prev: PageState = { type: 'active', session: createMockSession({ id: sessionId }) };

      const result = reconcileFromSync(prev, sessionId, [session]);

      expect(result.needsRefetch).toBe(false);
      expect(result.newState.type).toBe('paused');
    });
  });

  describe('session found in sync - disconnected', () => {
    it('should transition to disconnected when synced session is inactive without pausedAt', () => {
      const session = createMockSession({ id: sessionId, status: 'inactive' });
      const prev: PageState = { type: 'active', session: createMockSession({ id: sessionId }) };

      const result = reconcileFromSync(prev, sessionId, [session]);

      expect(result.needsRefetch).toBe(false);
      expect(result.newState.type).toBe('disconnected');
    });
  });

  describe('session not found in sync', () => {
    it('should request refetch when session is not in sync list', () => {
      const otherSession = createMockSession({ id: 'other-session' });
      const prev: PageState = { type: 'active', session: createMockSession({ id: sessionId }) };

      const result = reconcileFromSync(prev, sessionId, [otherSession]);

      expect(result.needsRefetch).toBe(true);
      expect(result.newState).toBe(prev); // Keeps current state until REST resolves
    });

    it('should request refetch when sync list is empty', () => {
      const prev: PageState = { type: 'active', session: createMockSession({ id: sessionId }) };

      const result = reconcileFromSync(prev, sessionId, []);

      expect(result.needsRefetch).toBe(true);
    });
  });

  describe('restarting state is preserved', () => {
    it('should not change state during restart even if session is in sync', () => {
      const session = createMockSession({ id: sessionId, status: 'active' });
      const prev: PageState = { type: 'restarting' };

      const result = reconcileFromSync(prev, sessionId, [session]);

      expect(result.needsRefetch).toBe(false);
      expect(result.newState).toBe(prev);
    });
  });

  describe('multiple sessions in sync', () => {
    it('should find the correct session among multiple', () => {
      const otherSession = createMockSession({ id: 'other', status: 'active' });
      const targetSession = createMockSession({ id: sessionId, status: 'active' });
      const prev: PageState = { type: 'loading' };

      const result = reconcileFromSync(prev, sessionId, [otherSession, targetSession]);

      expect(result.newState.type).toBe('active');
      if (result.newState.type === 'active') {
        expect(result.newState.session.id).toBe(sessionId);
      }
    });
  });
});

describe('SessionPage REST fallback reconciliation (session missing from sync)', () => {
  describe('session fetched from REST', () => {
    it('should transition to paused when fetched session has pausedAt', () => {
      const session = createMockSession({ pausedAt: '2026-01-01T00:00:00Z', status: 'inactive' });
      const prev: PageState = { type: 'active', session: createMockSession() };

      const result = reconcileFromFetchedSession(prev, session);

      expect(result.type).toBe('paused');
    });

    it('should transition to active when fetched session is active', () => {
      const session = createMockSession({ status: 'active' });
      const prev: PageState = { type: 'disconnected', session: createMockSession({ status: 'inactive' }) };

      const result = reconcileFromFetchedSession(prev, session);

      expect(result.type).toBe('active');
    });

    it('should transition to disconnected when fetched session is inactive without pausedAt', () => {
      const session = createMockSession({ status: 'inactive' });
      const prev: PageState = { type: 'active', session: createMockSession() };

      const result = reconcileFromFetchedSession(prev, session);

      expect(result.type).toBe('disconnected');
    });
  });

  describe('session not found via REST', () => {
    it('should transition to not_found when session does not exist', () => {
      const prev: PageState = { type: 'active', session: createMockSession() };

      const result = reconcileFromFetchedSession(prev, null);

      expect(result.type).toBe('not_found');
    });
  });

  describe('restarting state is preserved', () => {
    it('should not change state during restart even if REST returns data', () => {
      const session = createMockSession({ status: 'active' });
      const prev: PageState = { type: 'restarting' };

      const result = reconcileFromFetchedSession(prev, session);

      expect(result).toBe(prev);
    });
  });

  describe('not_found state is preserved', () => {
    it('should not change state when session-deleted arrived while REST was in-flight', () => {
      const session = createMockSession({ status: 'active' });
      const prev: PageState = { type: 'not_found' };

      const result = reconcileFromFetchedSession(prev, session);

      expect(result).toBe(prev);
    });
  });
});

describe('SessionPage session-resumed reconciliation', () => {
  const sessionId = 'session-1';

  it('should transition to active when this session is resumed', () => {
    const resumedSession = createMockSession({ id: sessionId, status: 'active' });
    const prev: PageState = { type: 'paused', session: createMockSession({ id: sessionId, pausedAt: '2026-01-01T00:00:00Z' }) };

    const result = reconcileFromResume(prev, sessionId, resumedSession);

    expect(result.type).toBe('active');
    if (result.type === 'active') {
      expect(result.session).toBe(resumedSession);
    }
  });

  it('should not change state when a different session is resumed', () => {
    const resumedSession = createMockSession({ id: 'other-session', status: 'active' });
    const prev: PageState = { type: 'paused', session: createMockSession({ id: sessionId }) };

    const result = reconcileFromResume(prev, sessionId, resumedSession);

    expect(result).toBe(prev);
  });

  it('should work from any state (loading, disconnected, etc.)', () => {
    const resumedSession = createMockSession({ id: sessionId, status: 'active' });

    // From loading
    const resultFromLoading = reconcileFromResume({ type: 'loading' }, sessionId, resumedSession);
    expect(resultFromLoading.type).toBe('active');

    // From disconnected
    const prevDisconnected: PageState = { type: 'disconnected', session: createMockSession({ id: sessionId }) };
    const resultFromDisconnected = reconcileFromResume(prevDisconnected, sessionId, resumedSession);
    expect(resultFromDisconnected.type).toBe('active');
  });

  it('should not change state when restarting', () => {
    const resumedSession = createMockSession({ id: sessionId, status: 'active' });
    const prev: PageState = { type: 'restarting' };

    const result = reconcileFromResume(prev, sessionId, resumedSession);

    expect(result).toBe(prev);
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
