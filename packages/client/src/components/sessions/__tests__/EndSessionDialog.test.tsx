import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EndSessionDialog, type EndSessionDialogProps } from '../EndSessionDialog';
import type { Session, Worker, AgentActivityState } from '@agent-console/shared';

const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} });

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
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
  return { id, type: 'embedded-agent', name: 'Embedded Agent', createdAt: '2026-01-01T00:00:00Z', embeddedAgentId: 'embedded-1', activated: true };
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderDialog(props: Partial<EndSessionDialogProps> = {}) {
  const defaultProps: EndSessionDialogProps = {
    open: true,
    onOpenChange: mock(() => {}),
    sessionId: 'session-1',
  };

  return render(
    <TestWrapper>
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
