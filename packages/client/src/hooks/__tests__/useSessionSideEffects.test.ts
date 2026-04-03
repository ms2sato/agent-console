import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type {
  Session,
  AgentActivityState,
  WorkerActivityInfo,
  WorktreeDeletionCompletedPayload,
} from '@agent-console/shared';
import type { UseWorktreeCreationTasksReturn } from '../useWorktreeCreationTasks';
import type { UseWorktreeDeletionTasksReturn } from '../useWorktreeDeletionTasks';

// --- Mock useAppWsEvent to capture registered callbacks ---

interface CapturedCallbacks {
  onSessionsSync?: (sessions: Session[], activityStates: WorkerActivityInfo[]) => void;
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (session: Session) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onSessionPaused?: (session: Session) => void;
  onSessionResumed?: (session: Session, activityStates: WorkerActivityInfo[]) => void;
  onWorkerActivity?: (sessionId: string, workerId: string, activityState: AgentActivityState) => void;
  onWorkerRestarted?: (sessionId: string, workerId: string, activityState: AgentActivityState) => void;
  onWorktreeCreationCompleted?: unknown;
  onWorktreeCreationFailed?: unknown;
  onWorktreeDeletionCompleted?: (payload: WorktreeDeletionCompletedPayload) => void;
  onWorktreeDeletionFailed?: unknown;
}

let capturedCallbacks: CapturedCallbacks = {};

mock.module('../useAppWs', () => ({
  useAppWsEvent: (options: CapturedCallbacks) => {
    capturedCallbacks = options;
  },
}));

// --- Mock side-effect modules ---

const mockClearTerminalState = mock(() => Promise.resolve());

mock.module('../../lib/terminal-state-cache', () => ({
  clearTerminalState: mockClearTerminalState,
}));

const mockDisconnectSession = mock(() => {});

mock.module('../../lib/worker-websocket', () => ({
  disconnectSession: mockDisconnectSession,
}));

const mockUpdateFavicon = mock(() => {});
const mockHasAnyAskingWorker = mock(() => false);

mock.module('../../lib/favicon-manager', () => ({
  updateFavicon: mockUpdateFavicon,
  hasAnyAskingWorker: mockHasAnyAskingWorker,
}));

mock.module('../../lib/logger', () => ({
  logger: { warn: mock(() => {}) },
}));

// Must import AFTER mock.module
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useSessionSideEffects } from '../useSessionSideEffects';

// --- Helpers ---

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'quick',
    locationPath: '/test/path',
    status: 'active',
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  } as Session;
}

function createMockWorktreeCreationTasks(): UseWorktreeCreationTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    handleWorktreeCreationCompleted: mock(() => {}),
    handleWorktreeCreationFailed: mock(() => {}),
  };
}

function createMockWorktreeDeletionTasks(): UseWorktreeDeletionTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    handleWorktreeDeletionCompleted: mock(() => {}),
    handleWorktreeDeletionFailed: mock(() => {}),
  };
}

interface DefaultOptions {
  sessions: Session[];
  handleSessionsSync: ReturnType<typeof mock>;
  handleSessionCreated: ReturnType<typeof mock>;
  handleSessionUpdated: ReturnType<typeof mock>;
  handleSessionDeleted: ReturnType<typeof mock>;
  handleSessionPaused: ReturnType<typeof mock>;
  handleSessionResumed: ReturnType<typeof mock>;
  handleWorkerActivity: ReturnType<typeof mock>;
  workerActivityStates: Record<string, Record<string, AgentActivityState>>;
  worktreeCreationTasks: UseWorktreeCreationTasksReturn;
  worktreeDeletionTasks: UseWorktreeDeletionTasksReturn;
}

function createDefaultOptions(overrides: Partial<DefaultOptions> = {}): DefaultOptions {
  return {
    sessions: [],
    handleSessionsSync: mock(() => {}),
    handleSessionCreated: mock(() => {}),
    handleSessionUpdated: mock(() => {}),
    handleSessionDeleted: mock(() => {}),
    handleSessionPaused: mock(() => {}),
    handleSessionResumed: mock(() => {}),
    handleWorkerActivity: mock(() => {}),
    workerActivityStates: {},
    worktreeCreationTasks: createMockWorktreeCreationTasks(),
    worktreeDeletionTasks: createMockWorktreeDeletionTasks(),
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderWithQueryClient(options: DefaultOptions) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
  const invalidateSpy = spyOn(queryClient, 'invalidateQueries');

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const result = renderHook(
    () => useSessionSideEffects(options),
    { wrapper },
  );

  return { ...result, queryClient, invalidateSpy };
}

describe('useSessionSideEffects', () => {
  beforeEach(() => {
    capturedCallbacks = {};
    mockClearTerminalState.mockClear();
    mockDisconnectSession.mockClear();
    mockUpdateFavicon.mockClear();
    mockHasAnyAskingWorker.mockClear();
  });

  afterEach(() => {
    queryClient?.clear();
  });

  describe('session validation invalidation', () => {
    it('should invalidate validation cache when session is created', () => {
      const options = createDefaultOptions();
      const { invalidateSpy } = renderWithQueryClient(options);

      const session = createMockSession();
      capturedCallbacks.onSessionCreated?.(session);

      expect(options.handleSessionCreated).toHaveBeenCalledWith(session);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['session-validation'] });
    });

    it('should invalidate validation cache when session is updated', () => {
      const options = createDefaultOptions();
      const { invalidateSpy } = renderWithQueryClient(options);

      const session = createMockSession();
      capturedCallbacks.onSessionUpdated?.(session);

      expect(options.handleSessionUpdated).toHaveBeenCalledWith(session);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['session-validation'] });
    });

    it('should invalidate validation cache when session is deleted', () => {
      const options = createDefaultOptions();
      const { invalidateSpy } = renderWithQueryClient(options);

      capturedCallbacks.onSessionDeleted?.('session-1');

      expect(options.handleSessionDeleted).toHaveBeenCalledWith('session-1');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['session-validation'] });
    });

    it('should invalidate validation cache on sessions sync', () => {
      const options = createDefaultOptions();
      const { invalidateSpy } = renderWithQueryClient(options);

      const sessions = [createMockSession()];
      const activityStates: WorkerActivityInfo[] = [];
      capturedCallbacks.onSessionsSync?.(sessions, activityStates);

      expect(options.handleSessionsSync).toHaveBeenCalledWith(sessions, activityStates);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['session-validation'] });
    });
  });

  describe('session delete: terminal state cleanup', () => {
    it('should clear terminal state for all workers before deleting session', () => {
      const worker1 = { id: 'w1', name: 'Worker 1', type: 'terminal' as const, activated: true, createdAt: '' };
      const worker2 = { id: 'w2', name: 'Worker 2', type: 'agent' as const, agentId: 'agent-1', activated: true, createdAt: '' };
      const session = createMockSession({
        id: 'session-to-delete',
        workers: [worker1, worker2],
      });

      const options = createDefaultOptions({ sessions: [session] });
      renderWithQueryClient(options);

      capturedCallbacks.onSessionDeleted?.('session-to-delete');

      expect(mockClearTerminalState).toHaveBeenCalledTimes(2);
      expect(mockClearTerminalState).toHaveBeenCalledWith('session-to-delete', 'w1');
      expect(mockClearTerminalState).toHaveBeenCalledWith('session-to-delete', 'w2');
    });

    it('should still call handleSessionDeleted even if session is not found in current list', () => {
      const options = createDefaultOptions({ sessions: [] });
      renderWithQueryClient(options);

      capturedCallbacks.onSessionDeleted?.('nonexistent');

      expect(options.handleSessionDeleted).toHaveBeenCalledWith('nonexistent');
      expect(mockClearTerminalState).not.toHaveBeenCalled();
    });
  });

  describe('session pause: WebSocket disconnect', () => {
    it('should disconnect session WebSocket when session is paused', () => {
      const options = createDefaultOptions();
      renderWithQueryClient(options);

      const session = createMockSession({ id: 'paused-session' });
      capturedCallbacks.onSessionPaused?.(session);

      expect(mockDisconnectSession).toHaveBeenCalledWith('paused-session');
      expect(options.handleSessionPaused).toHaveBeenCalledWith(session);
    });
  });

  describe('session resume: pass-through', () => {
    it('should pass through to handleSessionResumed without extra side effects', () => {
      const options = createDefaultOptions();
      renderWithQueryClient(options);

      const session = createMockSession();
      const activityStates: WorkerActivityInfo[] = [
        { sessionId: session.id, workerId: 'w1', activityState: 'active' },
      ];
      capturedCallbacks.onSessionResumed?.(session, activityStates);

      expect(options.handleSessionResumed).toHaveBeenCalledWith(session, activityStates);
    });
  });

  describe('worker restart: terminal state cleanup', () => {
    it('should clear terminal state and forward worker activity on restart', () => {
      const options = createDefaultOptions();
      renderWithQueryClient(options);

      capturedCallbacks.onWorkerRestarted?.('s1', 'w1', 'idle');

      expect(options.handleWorkerActivity).toHaveBeenCalledWith('s1', 'w1', 'idle');
      expect(mockClearTerminalState).toHaveBeenCalledWith('s1', 'w1');
    });
  });

  describe('worktree deletion completed: query invalidation', () => {
    it('should invalidate worktree queries and forward to deletion tasks handler', () => {
      const deletionTasks = createMockWorktreeDeletionTasks();
      const options = createDefaultOptions({ worktreeDeletionTasks: deletionTasks });
      const { invalidateSpy } = renderWithQueryClient(options);

      const payload: WorktreeDeletionCompletedPayload = {
        taskId: 'task-1',
        sessionId: 's1',
      };
      capturedCallbacks.onWorktreeDeletionCompleted?.(payload);

      expect(deletionTasks.handleWorktreeDeletionCompleted).toHaveBeenCalledWith(payload);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['worktrees'] });
    });
  });

  describe('worktree creation events: pass-through', () => {
    it('should forward worktree creation completed to creation tasks handler', () => {
      const creationTasks = createMockWorktreeCreationTasks();
      const options = createDefaultOptions({ worktreeCreationTasks: creationTasks });
      renderWithQueryClient(options);

      expect(capturedCallbacks.onWorktreeCreationCompleted).toBe(
        creationTasks.handleWorktreeCreationCompleted
      );
    });

    it('should forward worktree creation failed to creation tasks handler', () => {
      const creationTasks = createMockWorktreeCreationTasks();
      const options = createDefaultOptions({ worktreeCreationTasks: creationTasks });
      renderWithQueryClient(options);

      expect(capturedCallbacks.onWorktreeCreationFailed).toBe(
        creationTasks.handleWorktreeCreationFailed
      );
    });

    it('should forward worktree deletion failed to deletion tasks handler', () => {
      const deletionTasks = createMockWorktreeDeletionTasks();
      const options = createDefaultOptions({ worktreeDeletionTasks: deletionTasks });
      renderWithQueryClient(options);

      expect(capturedCallbacks.onWorktreeDeletionFailed).toBe(
        deletionTasks.handleWorktreeDeletionFailed
      );
    });
  });

  describe('favicon updates', () => {
    it('should call updateFavicon based on workerActivityStates', () => {
      const workerActivityStates: Record<string, Record<string, AgentActivityState>> = {
        's1': { 'w1': 'asking' },
      };
      mockHasAnyAskingWorker.mockReturnValue(true);

      const options = createDefaultOptions({ workerActivityStates });
      renderWithQueryClient(options);

      expect(mockHasAnyAskingWorker).toHaveBeenCalledWith(workerActivityStates);
      expect(mockUpdateFavicon).toHaveBeenCalledWith(true);
    });

    it('should call updateFavicon with false when no workers are asking', () => {
      const workerActivityStates: Record<string, Record<string, AgentActivityState>> = {
        's1': { 'w1': 'active' },
      };
      mockHasAnyAskingWorker.mockReturnValue(false);

      const options = createDefaultOptions({ workerActivityStates });
      renderWithQueryClient(options);

      expect(mockHasAnyAskingWorker).toHaveBeenCalledWith(workerActivityStates);
      expect(mockUpdateFavicon).toHaveBeenCalledWith(false);
    });
  });
});
