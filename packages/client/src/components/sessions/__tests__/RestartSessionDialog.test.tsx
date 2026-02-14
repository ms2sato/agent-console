import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RestartSessionDialog, type RestartSessionDialogProps } from '../RestartSessionDialog';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

const mockAgentsResponse = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', isBuiltIn: true },
    { id: 'custom-agent', name: 'Custom Agent', isBuiltIn: false },
  ],
};

const mockSessionResponse = {
  session: {
    id: 'session-1',
    workers: [
      { id: 'worker-1', type: 'agent', agentId: 'claude-code', name: 'Claude Code' },
    ],
    status: 'running',
    createdAt: '2026-01-01T00:00:00Z',
  },
};

const mockRestartResponse = {
  worker: { id: 'worker-1', type: 'agent', agentId: 'claude-code', name: 'Claude Code' },
};

function createMockResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function createErrorResponse(status: number, error: string) {
  return {
    ok: false,
    status,
    statusText: error,
    json: () => Promise.resolve({ error }),
  } as unknown as Response;
}

function resolveUrl(url: unknown): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  if (url && typeof url === 'object' && 'url' in url) return (url as Request).url;
  return '';
}

function routeFetchByUrl(urlStr: string): Response {
  if (urlStr.includes('/agents')) {
    return createMockResponse(mockAgentsResponse);
  }
  if (urlStr.includes('/restart')) {
    return createMockResponse(mockRestartResponse);
  }
  if (urlStr.includes('/sessions/')) {
    return createMockResponse(mockSessionResponse);
  }
  return createMockResponse({});
}

function setupDefaultMockFetch() {
  mockFetch.mockImplementation((...args: unknown[]) => {
    return Promise.resolve(routeFetchByUrl(resolveUrl(args[0])));
  });
}

/**
 * Find the fetch call that targeted the restart endpoint and parse its request body.
 */
function findRestartCallBody(): Record<string, unknown> | undefined {
  const calls = mockFetch.mock.calls as unknown[][];
  for (const call of calls) {
    const urlStr = resolveUrl(call[0]);
    if (urlStr.includes('/restart')) {
      const init = call[1] as RequestInit | undefined;
      if (init?.body && typeof init.body === 'string') {
        return JSON.parse(init.body) as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderDialog(props: Partial<RestartSessionDialogProps> = {}) {
  const defaultProps: RestartSessionDialogProps = {
    open: true,
    onOpenChange: mock(() => {}),
    sessionId: 'session-1',
    currentAgentId: 'claude-code',
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(
      <TestWrapper>
        <RestartSessionDialog {...mergedProps} />
      </TestWrapper>
    ),
    props: mergedProps,
  };
}

async function waitForAgentsToLoad() {
  await waitFor(() => {
    expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
  });
}

describe('RestartSessionDialog', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setupDefaultMockFetch();
  });

  describe('rendering', () => {
    it('should show dialog with title "Restart Session" when open', async () => {
      renderDialog();
      await waitForAgentsToLoad();

      expect(screen.getByText('Restart Session')).toBeTruthy();
      expect(screen.getByText('How would you like to restart this session?')).toBeTruthy();
    });

    it('should not render when closed', async () => {
      renderDialog({ open: false });

      expect(screen.queryByText('Restart Session')).toBeNull();
    });

    it('should show Agent selector', async () => {
      renderDialog();
      await waitForAgentsToLoad();

      expect(screen.getByText('Agent:')).toBeTruthy();
      expect(screen.getByRole('combobox')).toBeTruthy();
    });

    it('should show Branch input when isWorktreeSession is true', async () => {
      renderDialog({
        isWorktreeSession: true,
        currentBranch: 'feat/my-feature',
      });
      await waitForAgentsToLoad();

      expect(screen.getByText('Branch:')).toBeTruthy();
      expect(screen.getByPlaceholderText('Branch name')).toBeTruthy();
    });

    it('should NOT show Branch input when isWorktreeSession is false', async () => {
      renderDialog({ isWorktreeSession: false });
      await waitForAgentsToLoad();

      expect(screen.queryByText('Branch:')).toBeNull();
      expect(screen.queryByPlaceholderText('Branch name')).toBeNull();
    });

    it('should NOT show Branch input when isWorktreeSession is undefined', async () => {
      renderDialog({ isWorktreeSession: undefined });
      await waitForAgentsToLoad();

      expect(screen.queryByText('Branch:')).toBeNull();
      expect(screen.queryByPlaceholderText('Branch name')).toBeNull();
    });
  });

  describe('branch empty validation', () => {
    it('should show error and disable buttons when branch is cleared to empty', async () => {
      const user = userEvent.setup();
      renderDialog({
        isWorktreeSession: true,
        currentBranch: 'feat/my-feature',
      });
      await waitForAgentsToLoad();

      const branchInput = screen.getByPlaceholderText('Branch name');
      await user.clear(branchInput);

      expect(screen.getByText('Branch name cannot be empty.')).toBeTruthy();

      const newSessionButton = screen.getByText('New Session');
      expect(newSessionButton).toHaveProperty('disabled', true);

      const continueButton = screen.getByText('Continue (-c)');
      expect(continueButton).toHaveProperty('disabled', true);
    });

    it('should not show branch error when isWorktreeSession is false', async () => {
      renderDialog({ isWorktreeSession: false });
      await waitForAgentsToLoad();

      expect(screen.queryByText('Branch name cannot be empty.')).toBeNull();

      const newSessionButton = screen.getByText('New Session');
      expect(newSessionButton).toHaveProperty('disabled', false);
    });
  });

  describe('change warnings', () => {
    it('should show agent switch warning when a different agent is selected', async () => {
      const user = userEvent.setup();
      renderDialog({ currentAgentId: 'claude-code' });
      await waitForAgentsToLoad();

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'custom-agent');

      expect(
        screen.getByText('Agent will be switched. The terminal will be restarted with the new agent.')
      ).toBeTruthy();
    });

    it('should show branch rename warning when branch is changed', async () => {
      const user = userEvent.setup();
      renderDialog({
        isWorktreeSession: true,
        currentBranch: 'feat/old-branch',
      });
      await waitForAgentsToLoad();

      const branchInput = screen.getByPlaceholderText('Branch name');
      await user.clear(branchInput);
      await user.type(branchInput, 'feat/new-branch');

      expect(
        screen.getByText('Branch will be renamed. The terminal will be restarted.')
      ).toBeTruthy();
    });

    it('should show combined warning when both agent and branch are changed', async () => {
      const user = userEvent.setup();
      renderDialog({
        isWorktreeSession: true,
        currentBranch: 'feat/old-branch',
        currentAgentId: 'claude-code',
      });
      await waitForAgentsToLoad();

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'custom-agent');

      const branchInput = screen.getByPlaceholderText('Branch name');
      await user.clear(branchInput);
      await user.type(branchInput, 'feat/new-branch');

      expect(
        screen.getByText('Agent and branch will be changed. The terminal will be restarted.')
      ).toBeTruthy();
    });
  });

  describe('submission', () => {
    it('should call restartAgentWorker with continueConversation=false when clicking "New Session"', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      renderDialog({ onSessionRestart });
      await waitForAgentsToLoad();

      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onSessionRestart).toHaveBeenCalledTimes(1);
      });

      const body = findRestartCallBody();
      expect(body).toBeTruthy();
      expect(body!.continueConversation).toBe(false);
    });

    it('should call restartAgentWorker with continueConversation=true when clicking "Continue (-c)"', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      renderDialog({ onSessionRestart });
      await waitForAgentsToLoad();

      const continueButton = screen.getByText('Continue (-c)');
      await user.click(continueButton);

      await waitFor(() => {
        expect(onSessionRestart).toHaveBeenCalledTimes(1);
      });

      const body = findRestartCallBody();
      expect(body).toBeTruthy();
      expect(body!.continueConversation).toBe(true);
    });

    it('should pass agentId when agent is changed', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      renderDialog({ currentAgentId: 'claude-code', onSessionRestart });
      await waitForAgentsToLoad();

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'custom-agent');

      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onSessionRestart).toHaveBeenCalledTimes(1);
      });

      const body = findRestartCallBody();
      expect(body).toBeTruthy();
      expect(body!.agentId).toBe('custom-agent');
    });

    it('should pass branch when branch is changed in worktree session', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      const onBranchChange = mock(() => {});
      renderDialog({
        isWorktreeSession: true,
        currentBranch: 'feat/old-branch',
        onSessionRestart,
        onBranchChange,
      });
      await waitForAgentsToLoad();

      const branchInput = screen.getByPlaceholderText('Branch name');
      await user.clear(branchInput);
      await user.type(branchInput, 'feat/new-branch');

      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onSessionRestart).toHaveBeenCalledTimes(1);
      });

      const body = findRestartCallBody();
      expect(body).toBeTruthy();
      expect(body!.branch).toBe('feat/new-branch');
    });

    it('should call onBranchChange callback when branch is changed', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      const onBranchChange = mock(() => {});
      renderDialog({
        isWorktreeSession: true,
        currentBranch: 'feat/old-branch',
        onSessionRestart,
        onBranchChange,
      });
      await waitForAgentsToLoad();

      const branchInput = screen.getByPlaceholderText('Branch name');
      await user.clear(branchInput);
      await user.type(branchInput, 'feat/new-branch');

      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onBranchChange).toHaveBeenCalledWith('feat/new-branch');
      });
    });

    it('should call onSessionRestart callback after successful restart', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      renderDialog({ onSessionRestart });
      await waitForAgentsToLoad();

      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onSessionRestart).toHaveBeenCalledTimes(1);
      });
    });

    it('should close dialog after successful restart', async () => {
      const user = userEvent.setup();
      const onOpenChange = mock(() => {});
      renderDialog({ onOpenChange });
      await waitForAgentsToLoad();

      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('should show error when restart fails', async () => {
      // Override mock to fail on restart
      mockFetch.mockImplementation((...args: unknown[]) => {
        const urlStr = resolveUrl(args[0]);
        if (urlStr.includes('/agents')) {
          return Promise.resolve(createMockResponse(mockAgentsResponse));
        }
        if (urlStr.includes('/restart')) {
          return Promise.resolve(createErrorResponse(500, 'Worker restart failed'));
        }
        if (urlStr.includes('/sessions/')) {
          return Promise.resolve(createMockResponse(mockSessionResponse));
        }
        return Promise.resolve(createMockResponse({}));
      });

      const user = userEvent.setup();
      renderDialog();
      await waitForAgentsToLoad();

      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(screen.getByText('Worker restart failed')).toBeTruthy();
      });
    });

    it('should not pass agentId when agent is unchanged', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      renderDialog({ currentAgentId: 'claude-code', onSessionRestart });
      await waitForAgentsToLoad();

      // Do not change agent - just click restart
      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onSessionRestart).toHaveBeenCalledTimes(1);
      });

      const body = findRestartCallBody();
      expect(body).toBeTruthy();
      expect(body!.agentId).toBeUndefined();
    });

    it('should not pass branch when branch is unchanged', async () => {
      const user = userEvent.setup();
      const onSessionRestart = mock(() => {});
      renderDialog({
        isWorktreeSession: true,
        currentBranch: 'feat/my-feature',
        onSessionRestart,
      });
      await waitForAgentsToLoad();

      // Do not change branch - just click restart
      const newSessionButton = screen.getByText('New Session');
      await user.click(newSessionButton);

      await waitFor(() => {
        expect(onSessionRestart).toHaveBeenCalledTimes(1);
      });

      const body = findRestartCallBody();
      expect(body).toBeTruthy();
      expect(body!.branch).toBeUndefined();
    });
  });
});
