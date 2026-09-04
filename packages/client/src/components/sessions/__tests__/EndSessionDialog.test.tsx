import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EndSessionDialog, type EndSessionDialogProps } from '../EndSessionDialog';
import { SessionStopTasksContext } from '../../../contexts/root-contexts';
import { useSessionStopTasks, type UseSessionStopTasksReturn } from '../../../hooks/useSessionStopTasks';
import { renderWithRouter } from '../../../test/renderWithRouter';
import type { Session, Worker, AgentActivityState } from '@agent-console/shared';

const originalFetch = globalThis.fetch;
let resolveDeleteSession: (() => void) | null = null;
let rejectDeleteSession: ((err: Error) => void) | null = null;
const mockFetch = mock(
  () =>
    new Promise<Response>((resolve, reject) => {
      resolveDeleteSession = () => resolve(new Response(null, { status: 204 }));
      rejectDeleteSession = (err) => reject(err);
    })
);
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} });

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
  mockFetch.mockClear();
  resolveDeleteSession = null;
  rejectDeleteSession = null;
});

function createMockSession(workers: Worker[]): Session {
  return {
    type: 'quick',
    id: 'session-1',
    locationPath: '/tmp/session-1',
    status: 'active',
    activationState: 'running',
    createdAt: '2026-01-01T00:00:00Z',
    workers,
    isShared: false,
    recoveryState: 'healthy',
  };
}

function agentWorker(id: string): Worker {
  return { id, type: 'agent', name: 'Claude Code', createdAt: '2026-01-01T00:00:00Z', agentId: 'claude-code', activated: true };
}

function embeddedAgentWorker(id: string): Worker {
  return { id, type: 'embedded-agent', name: 'Embedded Agent', createdAt: '2026-01-01T00:00:00Z', embeddedAgentId: 'embedded-1', activated: true, autoCompaction: true, reasoningEffort: null, hasParameterOverride: false };
}

function createMockSessionStopTasks(overrides: Partial<UseSessionStopTasksReturn> = {}): UseSessionStopTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => true),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    ...overrides,
  };
}

function TestWrapper({ children, sessionStopTasks }: { children: React.ReactNode; sessionStopTasks: UseSessionStopTasksReturn }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <SessionStopTasksContext.Provider value={sessionStopTasks}>
        {children}
      </SessionStopTasksContext.Provider>
    </QueryClientProvider>
  );
}

function renderDialog(props: Partial<EndSessionDialogProps> = {}, sessionStopTasks: UseSessionStopTasksReturn = createMockSessionStopTasks()) {
  const defaultProps: EndSessionDialogProps = {
    open: true,
    onOpenChange: mock(() => {}),
    sessionId: 'session-1',
  };

  return render(
    <TestWrapper sessionStopTasks={sessionStopTasks}>
      <EndSessionDialog {...defaultProps} {...props} />
    </TestWrapper>
  );
}

const WARNING_TEXT = 'Warning: This session has active workers. Ending will stop all work in progress.';

describe('EndSessionDialog', () => {
  it('shows the active-worker warning when an embedded-agent worker is active', () => {
    const session = createMockSession([embeddedAgentWorker('worker-1')]);
    const workerActivityStates: Record<string, AgentActivityState> = { 'worker-1': 'active' };

    renderDialog({ session, workerActivityStates });

    expect(screen.getByText(WARNING_TEXT)).toBeTruthy();
  });

  it('shows the active-worker warning when a PTY agent worker is active', () => {
    const session = createMockSession([agentWorker('worker-1')]);
    const workerActivityStates: Record<string, AgentActivityState> = { 'worker-1': 'active' };

    renderDialog({ session, workerActivityStates });

    expect(screen.getByText(WARNING_TEXT)).toBeTruthy();
  });

  it('shows the active-worker warning when a PTY agent worker is asking', () => {
    const session = createMockSession([agentWorker('worker-1')]);
    const workerActivityStates: Record<string, AgentActivityState> = { 'worker-1': 'asking' };

    renderDialog({ session, workerActivityStates });

    expect(screen.getByText(WARNING_TEXT)).toBeTruthy();
  });

  it('does not show the warning when the embedded-agent worker is idle', () => {
    const session = createMockSession([embeddedAgentWorker('worker-1')]);
    const workerActivityStates: Record<string, AgentActivityState> = { 'worker-1': 'idle' };

    renderDialog({ session, workerActivityStates });

    expect(screen.queryByText(WARNING_TEXT)).toBeNull();
  });

  it('does not show the warning when session or workerActivityStates are undefined', () => {
    renderDialog();

    expect(screen.queryByText(WARNING_TEXT)).toBeNull();
  });
});

/**
 * Tests for Issue #1247 -- Stop Session no longer holds a modal open while the
 * server round-trip is in flight. These tests exercise the confirm handler's
 * synchronous close + fire-and-forget API call, mirroring DeleteWorktreeDialog's
 * pattern. A real router (via renderWithRouter) and a real
 * SessionStopTasksContext.Provider are used instead of mock.module(), which is
 * process-global in bun:test and would poison other test files that import
 * routes/__root or contexts/root-contexts for real (testing.md Anti-Pattern #2).
 */
describe('EndSessionDialog / Issue #1247 scoped pending state', () => {
  async function renderWithRouterAndContext(
    props: Partial<EndSessionDialogProps> = {},
    sessionStopTasks: UseSessionStopTasksReturn = createMockSessionStopTasks()
  ) {
    const defaultProps: EndSessionDialogProps = {
      open: true,
      onOpenChange: mock(() => {}),
      sessionId: 'session-1',
    };

    return renderWithRouter(
      <SessionStopTasksContext.Provider value={sessionStopTasks}>
        <EndSessionDialog {...defaultProps} {...props} />
      </SessionStopTasksContext.Provider>
    );
  }

  it('closes the dialog synchronously on confirm, without awaiting the deleteSession fetch call', async () => {
    // POLARITY CHECK (workflow.md TDD requirement): this exact assertion was
    // run against the pre-conversion EndSessionDialog.tsx (the useMutation +
    // isPending-gated AlertDialog implementation) and FAILED there, because
    // the old handleClose guarded onOpenChange(false) behind
    // `!deleteMutation.isPending` -- the dialog stayed open until the fetch
    // promise settled. It passes here against the converted implementation,
    // which calls onOpenChange(false) synchronously in handleStop before ever
    // awaiting deleteSession().
    const onOpenChange = mock(() => {});
    await renderWithRouterAndContext({ onOpenChange });

    fireEvent.click(screen.getByRole('button', { name: 'Stop Session' }));

    // Assert synchronously (before resolving/flushing the mocked fetch promise).
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The underlying fetch call has been made, but is still unresolved.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(resolveDeleteSession).not.toBeNull();

    // Clean up: resolve the pending fetch so the test doesn't leak a dangling promise.
    resolveDeleteSession?.();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  it('double-clicking confirm before the dialog unmounts results in exactly one deleteSession call', async () => {
    // Uses the REAL useSessionStopTasks hook (not a mock) so addTask's
    // at-most-one-per-session dedupe is actually exercised -- a mock that
    // unconditionally returns `true` would not catch a regression where the
    // guard `if (!added) return;` is removed from handleStop.
    function RealSessionStopTasksProvider({ children }: { children: React.ReactNode }) {
      const sessionStopTasks = useSessionStopTasks();
      return (
        <SessionStopTasksContext.Provider value={sessionStopTasks}>
          {children}
        </SessionStopTasksContext.Provider>
      );
    }

    const defaultProps: EndSessionDialogProps = {
      open: true,
      onOpenChange: mock(() => {}),
      sessionId: 'session-1',
    };
    await renderWithRouter(
      <RealSessionStopTasksProvider>
        <EndSessionDialog {...defaultProps} />
      </RealSessionStopTasksProvider>
    );

    const button = screen.getByRole('button', { name: 'Stop Session' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveDeleteSession?.();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  it('calls markAsFailed with a message when deleteSession rejects', async () => {
    const sessionStopTasks = createMockSessionStopTasks();
    await renderWithRouterAndContext({}, sessionStopTasks);

    fireEvent.click(screen.getByRole('button', { name: 'Stop Session' }));

    rejectDeleteSession?.(new Error('Network error'));

    await waitFor(() => {
      expect(sessionStopTasks.markAsFailed).toHaveBeenCalledWith('session-1', 'Network error');
    });
  });
});
