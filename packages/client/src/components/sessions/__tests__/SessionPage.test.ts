/**
 * Tests for SessionPage logic that remains in SessionPage.tsx.
 *
 * Tests the extracted workerRestart module directly, which is the same
 * pure logic used by SessionPage.tsx. This avoids re-implementing production
 * code in tests (logic duplication anti-pattern).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Session, Worker } from '@agent-console/shared';
import {
  extractRestartableSession,
  findAgentWorker,
  executeWorkerRestart,
  type WorkerRestartResult,
} from '../workerRestart';
import { sessionToPageState } from '../SessionPage';

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

describe('extractRestartableSession', () => {
  it('should return session for active state', () => {
    const session = createMockSession();
    const result = extractRestartableSession('active', session);
    expect(result).toBe(session);
  });

  it('should return session for disconnected state', () => {
    const session = createMockSession();
    const result = extractRestartableSession('disconnected', session);
    expect(result).toBe(session);
  });

  it('should return null for loading state', () => {
    expect(extractRestartableSession('loading', undefined)).toBeNull();
  });

  it('should return null for not_found state', () => {
    expect(extractRestartableSession('not_found', undefined)).toBeNull();
  });

  it('should return null for server_unavailable state', () => {
    expect(extractRestartableSession('server_unavailable', undefined)).toBeNull();
  });

  it('should return null for restarting state', () => {
    expect(extractRestartableSession('restarting', undefined)).toBeNull();
  });

  it('should return null for paused state', () => {
    // Paused state has a session but is not restartable
    expect(extractRestartableSession('paused', createMockSession())).toBeNull();
  });
});

describe('findAgentWorker', () => {
  it('should find the first agent worker', () => {
    const workers: Worker[] = [
      { id: 'terminal-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
      { id: 'agent-1', type: 'agent', name: 'Claude Code 1', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
      { id: 'agent-2', type: 'agent', name: 'Claude Code 2', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
    ] as Worker[];

    const result = findAgentWorker(workers);
    expect(result?.id).toBe('agent-1');
  });

  it('should return undefined when no agent worker exists', () => {
    const workers: Worker[] = [
      { id: 'terminal-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
    ] as Worker[];

    expect(findAgentWorker(workers)).toBeUndefined();
  });
});

describe('executeWorkerRestart', () => {
  let mockRestartAgentWorker: ReturnType<typeof mock>;
  let mockGetSession: ReturnType<typeof mock>;
  let mockUpdateTabsFromSession: ReturnType<typeof mock>;

  beforeEach(() => {
    mockRestartAgentWorker = mock(() => Promise.resolve({ worker: { id: 'agent-worker-1' } }));
    mockGetSession = mock(() => Promise.resolve(createMockSession()));
    mockUpdateTabsFromSession = mock(() => {});
  });

  function callRestart(overrides: {
    session?: Session;
    sessionId?: string;
    continueConversation?: boolean;
  } = {}): Promise<WorkerRestartResult> {
    return executeWorkerRestart({
      session: overrides.session ?? createMockSession(),
      sessionId: overrides.sessionId ?? 'session-1',
      continueConversation: overrides.continueConversation ?? true,
      deps: {
        restartAgentWorker: mockRestartAgentWorker,
        getSession: mockGetSession,
      },
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
    it('should return active state when updated session is active', async () => {
      const updatedSession = createMockSession({ status: 'active' });
      mockGetSession.mockReturnValue(Promise.resolve(updatedSession));

      const result = await callRestart();

      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.newState.type).toBe('active');
        if (result.newState.type === 'active') {
          expect(result.newState.session).toBe(updatedSession);
        }
      }
      expect(mockUpdateTabsFromSession).toHaveBeenCalledWith(updatedSession.workers);
    });

    it('should return disconnected state when updated session is inactive', async () => {
      const updatedSession = createMockSession({ status: 'inactive' });
      mockGetSession.mockReturnValue(Promise.resolve(updatedSession));

      const result = await callRestart();

      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.newState.type).toBe('disconnected');
        if (result.newState.type === 'disconnected') {
          expect(result.newState.session).toBe(updatedSession);
        }
      }
    });

    it('should return session_gone when session no longer exists after restart', async () => {
      mockGetSession.mockReturnValue(Promise.resolve(null));

      const result = await callRestart();

      expect(result.outcome).toBe('session_gone');
    });
  });

  describe('works from disconnected state session', () => {
    it('should restart with an inactive session same as active', async () => {
      const session = createMockSession({ status: 'inactive' });
      const updatedSession = createMockSession({ status: 'active' });
      mockGetSession.mockReturnValue(Promise.resolve(updatedSession));

      const result = await callRestart({ session });

      expect(mockRestartAgentWorker).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.newState.type).toBe('active');
      }
    });
  });

  describe('error when no agent worker found', () => {
    it('should return no_agent_worker when session has no agent workers', async () => {
      const session = createMockSession({
        workers: [
          { id: 'terminal-worker-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
        ] as Worker[],
      });

      const result = await callRestart({ session });

      expect(result.outcome).toBe('no_agent_worker');
      if (result.outcome === 'no_agent_worker') {
        expect(result.errorTitle).toBe('Restart Failed');
        expect(result.errorMessage).toBe('No agent worker found in session');
      }
      expect(mockRestartAgentWorker).not.toHaveBeenCalled();
    });
  });

  describe('API failure handling', () => {
    it('should return error with message when API call fails', async () => {
      const session = createMockSession();
      mockRestartAgentWorker.mockReturnValue(Promise.reject(new Error('Network error: server unreachable')));

      const result = await callRestart({ session });

      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.errorTitle).toBe('Restart Failed');
        expect(result.errorMessage).toBe('Network error: server unreachable');
        expect(result.fallbackState.type).toBe('disconnected');
        expect(result.fallbackState.session).toBe(session);
      }
    });

    it('should handle non-Error exceptions in API failure', async () => {
      mockRestartAgentWorker.mockReturnValue(Promise.reject('string error'));

      const result = await callRestart();

      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.errorMessage).toBe('Failed to restart session');
      }
    });

    it('should return error when getSession fails after successful restart', async () => {
      mockGetSession.mockReturnValue(Promise.reject(new Error('Failed to reload session')));

      const result = await callRestart();

      expect(mockRestartAgentWorker).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.errorMessage).toBe('Failed to reload session');
      }
    });
  });

  describe('skipped outcome type contract', () => {
    it('should be a valid WorkerRestartResult outcome that callers must handle', () => {
      // The 'skipped' outcome is part of the WorkerRestartResult union type.
      // While executeWorkerRestart does not currently produce it, callers (SessionPage)
      // must handle it correctly by resetting the UI state from 'restarting' back to
      // the pre-restart state. This test documents the type contract.
      const skippedResult: WorkerRestartResult = { outcome: 'skipped' };
      expect(skippedResult.outcome).toBe('skipped');
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

      await callRestart({ session });

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

  it('should transition from paused to active when pausedAt is cleared after resume', () => {
    // Verify the contract that SessionPage relies on after resume:
    // When session-resumed WS event delivers a session with pausedAt cleared,
    // sessionToPageState correctly returns 'active' (enabling reactive state
    // transition without window.location.reload).
    const pausedSession = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' });
    expect(sessionToPageState(pausedSession).type).toBe('paused');

    const resumedSession = createMockSession({ status: 'active' });
    const result = sessionToPageState(resumedSession);

    expect(result.type).toBe('active');
    expect(result.session).toBe(resumedSession);
  });

  it('should return orphaned when session recoveryState is orphaned', () => {
    const session = createMockSession({ status: 'inactive', recoveryState: 'orphaned' });

    const result = sessionToPageState(session);

    expect(result.type).toBe('orphaned');
    expect(result.session).toBe(session);
  });

  it('should prioritize orphaned over pausedAt', () => {
    // An orphaned session must never be shown as "paused", since users cannot
    // resume it. This guards against pausedAt-based fallbacks overriding the
    // orphaned indicator.
    const session = createMockSession({
      status: 'inactive',
      pausedAt: '2026-01-01T00:00:00Z',
      recoveryState: 'orphaned',
    });

    const result = sessionToPageState(session);

    expect(result.type).toBe('orphaned');
  });

  it('should prioritize orphaned over active status', () => {
    // Edge case: a server could hypothetically surface an orphaned session with
    // status=active. The client must still treat it as orphaned.
    const session = createMockSession({ status: 'active', recoveryState: 'orphaned' });

    const result = sessionToPageState(session);

    expect(result.type).toBe('orphaned');
  });
});
