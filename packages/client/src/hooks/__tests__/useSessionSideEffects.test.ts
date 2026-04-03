import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type {
  Session,
  AgentActivityState,
} from '@agent-console/shared';
import type { UseWorktreeCreationTasksReturn } from '../useWorktreeCreationTasks';
import type { UseWorktreeDeletionTasksReturn } from '../useWorktreeDeletionTasks';
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
    // Reset mocks between tests
  });

  afterEach(() => {
    queryClient?.clear();
  });

  it('should render without errors', () => {
    const options = createDefaultOptions();
    const { result } = renderWithQueryClient(options);
    // Hook returns void — just ensure it doesn't throw
    expect(result.current).toBeUndefined();
  });

  it('should accept all required options', () => {
    const session = createMockSession();
    const options = createDefaultOptions({
      sessions: [session],
      workerActivityStates: { [session.id]: { 'w1': 'active' as AgentActivityState } },
    });

    // Should render without throwing
    expect(() => renderWithQueryClient(options)).not.toThrow();
  });

  it('should re-render when options change', () => {
    const options = createDefaultOptions();
    const { rerender } = renderWithQueryClient(options);

    // Update with new sessions
    const newOptions = createDefaultOptions({
      sessions: [createMockSession()],
    });
    rerender(newOptions);

    // No errors on rerender
  });
});
