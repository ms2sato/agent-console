import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useTabManagement } from '../useTabManagement';
import type { Worker, AgentActivityState } from '@agent-console/shared';

type UseTabManagementOptions = Parameters<typeof useTabManagement>[0];

// --- Fetch-level mocking ---

const originalFetch = globalThis.fetch;

/** Tracks fetch calls for assertions */
let fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];

/** Default response for createWorker POST */
const defaultCreateWorkerResponse = () => ({
  worker: {
    id: 'new-terminal-1',
    type: 'terminal' as const,
    name: 'Shell 1',
    createdAt: new Date().toISOString(),
    activated: true,
  },
});

/** Configurable response for createWorker */
let createWorkerResponse: () => unknown = defaultCreateWorkerResponse;

/**
 * Mock fetch that intercepts worker API calls.
 * POST to /workers -> createWorker
 * DELETE to /workers/:id -> deleteWorker
 */
const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  // Parse body if present
  let body: unknown;
  if (init?.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = init.body;
    }
  } else if (input instanceof Request) {
    try {
      body = await input.clone().json();
    } catch {
      // no body
    }
  }

  fetchCalls.push({ url, method, body });

  // POST /api/sessions/:sessionId/workers -> createWorker
  if (method === 'POST' && /\/sessions\/[^/]+\/workers$/.test(url)) {
    return new Response(JSON.stringify(createWorkerResponse()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // DELETE /api/sessions/:sessionId/workers/:workerId -> deleteWorker
  if (method === 'DELETE' && /\/sessions\/[^/]+\/workers\/[^/]+$/.test(url)) {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fallback: return 404
  return new Response('Not Found', { status: 404 });
});

globalThis.fetch = mockFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// --- Helpers ---

function createAgentWorker(id: string, name = 'Agent'): Worker {
  return { id, type: 'agent', name, createdAt: new Date().toISOString(), agentId: 'claude-code-builtin', activated: true };
}

function createTerminalWorker(id: string, name = 'Shell 1'): Worker {
  return { id, type: 'terminal', name, createdAt: new Date().toISOString(), activated: true };
}

function createGitDiffWorker(id: string, name = 'Git Diff'): Worker {
  return { id, type: 'git-diff', name, createdAt: new Date().toISOString(), baseCommit: 'abc123' };
}

function createEmbeddedAgentWorker(id: string, name = 'Local GPT'): Worker {
  return { id, type: 'embedded-agent', name, createdAt: new Date().toISOString(), embeddedAgentId: 'embedded-def-1', activated: true };
}

function createDefaultOptions(overrides: Partial<UseTabManagementOptions> = {}): UseTabManagementOptions {
  return {
    sessionId: 'session-1',
    activeSession: null,
    urlWorkerId: undefined,
    navigateToWorker: mock(() => {}),
    navigateToSession: mock(() => {}),
    showError: mock(() => {}),
    workerActivityStates: {},
    setActivityState: mock(() => {}),
    setExitInfo: mock(() => {}),
    ...overrides,
  };
}

/** Find fetch calls matching a URL pattern */
function findFetchCalls(pattern: RegExp) {
  return fetchCalls.filter(c => pattern.test(c.url));
}

describe('useTabManagement', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    fetchCalls = [];
    createWorkerResponse = defaultCreateWorkerResponse;
  });

  describe('tab initialization', () => {
    it('initializes tabs from session workers when activeSession is provided', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs[0]).toEqual({ id: 'agent-1', workerType: 'agent', name: 'Agent' });
      expect(result.current.tabs[1]).toEqual({ id: 'terminal-1', workerType: 'terminal', name: 'Shell 1' });
    });

    it('sets activeTabId from urlWorkerId when valid', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'terminal-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.activeTabId).toBe('terminal-1');
    });

    it('redirects to default (first agent) worker when no urlWorkerId', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: undefined,
        navigateToWorker,
      });

      const { result } = renderHook(() => useTabManagement(options));

      // Should set activeTabId to the first agent worker
      expect(result.current.activeTabId).toBe('agent-1');
      // Should navigate to the default worker with replace
      expect(navigateToWorker).toHaveBeenCalledWith('agent-1', true);
    });

    it('redirects to default worker when urlWorkerId is invalid', () => {
      const workers = [createAgentWorker('agent-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'nonexistent-worker',
        navigateToWorker,
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.activeTabId).toBe('agent-1');
      // The initialization effect redirects to the default worker
      expect(navigateToWorker).toHaveBeenCalledWith('agent-1', true);
    });

    it('sets activityState from workerActivityStates when urlWorkerId is valid', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const setActivityState = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        workerActivityStates: { 'agent-1': 'idle' as AgentActivityState },
        setActivityState,
      });

      renderHook(() => useTabManagement(options));

      expect(setActivityState).toHaveBeenCalledWith('idle');
    });

    it('sets activityState from workerActivityStates when redirecting to default tab', () => {
      const workers = [createAgentWorker('agent-1')];
      const setActivityState = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: undefined,
        workerActivityStates: { 'agent-1': 'active' as AgentActivityState },
        setActivityState,
      });

      renderHook(() => useTabManagement(options));

      expect(setActivityState).toHaveBeenCalledWith('active');
    });

    it('sets activityState to unknown when worker has no known state on init', () => {
      const workers = [createAgentWorker('agent-1')];
      const setActivityState = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        workerActivityStates: {},
        setActivityState,
      });

      renderHook(() => useTabManagement(options));

      expect(setActivityState).toHaveBeenCalledWith('unknown');
    });
  });

  describe('URL sync', () => {
    it('updates activeTabId when urlWorkerId changes to a valid worker', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result, rerender } = renderHook(
        (props: UseTabManagementOptions) => useTabManagement(props),
        { initialProps: options }
      );

      expect(result.current.activeTabId).toBe('agent-1');

      // Change urlWorkerId to terminal-1
      rerender({ ...options, urlWorkerId: 'terminal-1' });

      expect(result.current.activeTabId).toBe('terminal-1');
    });

    it('calls navigateToSession when urlWorkerId is invalid', () => {
      const workers = [createAgentWorker('agent-1')];
      const navigateToSession = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        navigateToSession,
      });

      const { rerender } = renderHook(
        (props: UseTabManagementOptions) => useTabManagement(props),
        { initialProps: options }
      );

      navigateToSession.mockClear();

      // Change to invalid urlWorkerId
      rerender({ ...options, urlWorkerId: 'invalid-worker' });

      expect(navigateToSession).toHaveBeenCalled();
    });

    it('calls navigateToWorker with default tab when urlWorkerId is empty', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        navigateToWorker,
      });

      const { rerender } = renderHook(
        (props: UseTabManagementOptions) => useTabManagement(props),
        { initialProps: options }
      );

      navigateToWorker.mockClear();

      // Change to empty urlWorkerId
      rerender({ ...options, urlWorkerId: undefined });

      expect(navigateToWorker).toHaveBeenCalledWith('agent-1', true);
    });
  });

  describe('tab CRUD', () => {
    it('addTerminalTab creates worker and adds tab', async () => {
      const workers = [createAgentWorker('agent-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        navigateToWorker,
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(1);

      navigateToWorker.mockClear();

      await act(async () => {
        await result.current.addTerminalTab();
      });

      // Verify the POST was made to the workers endpoint
      const postCalls = findFetchCalls(/\/sessions\/session-1\/workers$/);
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].method).toBe('POST');
      expect(postCalls[0].body).toEqual({
        type: 'terminal',
        name: 'Shell 1',
      });
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs[1].workerType).toBe('terminal');
      // addTerminalTab navigates to the new worker (URL would then update urlWorkerId)
      expect(navigateToWorker).toHaveBeenCalledWith('new-terminal-1');
    });

    it('closeTab deletes worker and removes tab', async () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(2);

      await act(async () => {
        await result.current.closeTab('terminal-1');
      });

      // Verify the DELETE was made
      const deleteCalls = findFetchCalls(/\/sessions\/session-1\/workers\/terminal-1$/);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].method).toBe('DELETE');
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe('agent-1');
    });

    it('closeTab switches to agent tab when closing active tab', async () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'terminal-1',
        navigateToWorker,
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.activeTabId).toBe('terminal-1');

      navigateToWorker.mockClear();

      await act(async () => {
        await result.current.closeTab('terminal-1');
      });

      expect(result.current.activeTabId).toBe('agent-1');
      expect(navigateToWorker).toHaveBeenCalledWith('agent-1');
    });

    it('does not close agent tabs', async () => {
      const workers = [createAgentWorker('agent-1')];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      await act(async () => {
        await result.current.closeTab('agent-1');
      });

      // No DELETE should have been made
      const deleteCalls = findFetchCalls(/\/workers\//);
      expect(deleteCalls).toHaveLength(0);
      expect(result.current.tabs).toHaveLength(1);
    });

    it('does not close git-diff tabs', async () => {
      const workers = [createAgentWorker('agent-1'), createGitDiffWorker('gitdiff-1')];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      await act(async () => {
        await result.current.closeTab('gitdiff-1');
      });

      // No DELETE should have been made
      const deleteCalls = findFetchCalls(/\/workers\//);
      expect(deleteCalls).toHaveLength(0);
      expect(result.current.tabs).toHaveLength(2);
    });

    it('addAgentTab creates an embedded-agent worker and adds tab', async () => {
      const workers = [createAgentWorker('agent-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        navigateToWorker,
      });
      createWorkerResponse = () => ({
        worker: {
          id: 'new-embedded-1',
          type: 'embedded-agent',
          name: 'Local GPT',
          embeddedAgentId: 'embedded-def-1',
          createdAt: new Date().toISOString(),
          activated: false,
        },
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(1);

      navigateToWorker.mockClear();

      await act(async () => {
        await result.current.addAgentTab({ type: 'embedded-agent', embeddedAgentId: 'embedded-def-1' });
      });

      const postCalls = findFetchCalls(/\/sessions\/session-1\/workers$/);
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].body).toEqual({
        type: 'embedded-agent',
        embeddedAgentId: 'embedded-def-1',
      });
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs[1].workerType).toBe('embedded-agent');
      expect(navigateToWorker).toHaveBeenCalledWith('new-embedded-1');
    });

    it('addAgentTab creates an agent worker and adds tab (Issue #1023)', async () => {
      const workers = [createAgentWorker('agent-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        navigateToWorker,
      });
      createWorkerResponse = () => ({
        worker: {
          id: 'new-agent-1',
          type: 'agent',
          name: 'Claude Code',
          agentId: 'claude-code-builtin',
          createdAt: new Date().toISOString(),
          activated: true,
        },
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(1);

      navigateToWorker.mockClear();

      await act(async () => {
        await result.current.addAgentTab({ type: 'agent', agentId: 'claude-code-builtin' });
      });

      const postCalls = findFetchCalls(/\/sessions\/session-1\/workers$/);
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].body).toEqual({
        type: 'agent',
        agentId: 'claude-code-builtin',
      });
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs[1].workerType).toBe('agent');
      expect(navigateToWorker).toHaveBeenCalledWith('new-agent-1');
    });

    it('addAgentTab surfaces an error via showError on API failure', async () => {
      const workers = [createAgentWorker('agent-1')];
      const showError = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        showError,
      });
      mockFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 400 }));

      const { result } = renderHook(() => useTabManagement(options));

      await act(async () => {
        await result.current.addAgentTab({ type: 'embedded-agent', embeddedAgentId: 'embedded-def-1' });
      });

      expect(showError).toHaveBeenCalledWith('Failed to Create Worker', expect.any(String));
      expect(result.current.tabs).toHaveLength(1);
    });

    it('closeTab deletes a second (non-primary) agent worker and removes tab (Issue #1134)', async () => {
      const workers = [
        createAgentWorker('agent-1'),
        createTerminalWorker('terminal-1'),
        createAgentWorker('agent-2', 'Claude Code 2'),
      ];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(3);

      await act(async () => {
        await result.current.closeTab('agent-2');
      });

      const deleteCalls = findFetchCalls(/\/sessions\/session-1\/workers\/agent-2$/);
      expect(deleteCalls).toHaveLength(1);
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs.map(t => t.id)).toEqual(['agent-1', 'terminal-1']);
    });

    it('does not close the primary agent tab even when a second agent worker exists (Issue #1134)', async () => {
      const workers = [
        createAgentWorker('agent-1'),
        createTerminalWorker('terminal-1'),
        createAgentWorker('agent-2', 'Claude Code 2'),
      ];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      await act(async () => {
        await result.current.closeTab('agent-1');
      });

      const deleteCalls = findFetchCalls(/\/workers\//);
      expect(deleteCalls).toHaveLength(0);
      expect(result.current.tabs).toHaveLength(3);
    });

    it('closeTab deletes an embedded-agent worker and removes tab', async () => {
      const workers = [createAgentWorker('agent-1'), createEmbeddedAgentWorker('embedded-1')];
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(2);

      await act(async () => {
        await result.current.closeTab('embedded-1');
      });

      const deleteCalls = findFetchCalls(/\/sessions\/session-1\/workers\/embedded-1$/);
      expect(deleteCalls).toHaveLength(1);
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe('agent-1');
    });
  });

  describe('handleTabClick', () => {
    it('sets activeTabId and navigates', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const navigateToWorker = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        navigateToWorker,
      });

      const { result, rerender } = renderHook(
        (props: UseTabManagementOptions) => useTabManagement(props),
        { initialProps: options }
      );

      navigateToWorker.mockClear();

      act(() => {
        result.current.handleTabClick('terminal-1');
      });

      // handleTabClick calls navigateToWorker (which would update the URL)
      expect(navigateToWorker).toHaveBeenCalledWith('terminal-1');

      // Simulate the URL updating to match the navigation
      rerender({ ...options, urlWorkerId: 'terminal-1' });

      expect(result.current.activeTabId).toBe('terminal-1');
    });

    it('resets activity state and exit info', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const setActivityState = mock(() => {});
      const setExitInfo = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        workerActivityStates: { 'terminal-1': 'idle' as AgentActivityState },
        setActivityState,
        setExitInfo,
      });

      const { result } = renderHook(() => useTabManagement(options));

      act(() => {
        result.current.handleTabClick('terminal-1');
      });

      expect(setActivityState).toHaveBeenCalledWith('idle');
      expect(setExitInfo).toHaveBeenCalledWith(undefined);
    });

    it('sets activity state to unknown when worker has no known state', () => {
      const workers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];
      const setActivityState = mock(() => {});
      const options = createDefaultOptions({
        activeSession: { workers },
        urlWorkerId: 'agent-1',
        workerActivityStates: {},
        setActivityState,
      });

      const { result } = renderHook(() => useTabManagement(options));

      act(() => {
        result.current.handleTabClick('terminal-1');
      });

      expect(setActivityState).toHaveBeenCalledWith('unknown');
    });
  });

  describe('updateTabsFromSession', () => {
    it('updates tabs from new workers array', () => {
      const initialWorkers = [createAgentWorker('agent-1')];
      const options = createDefaultOptions({
        activeSession: { workers: initialWorkers },
        urlWorkerId: 'agent-1',
      });

      const { result } = renderHook(() => useTabManagement(options));

      expect(result.current.tabs).toHaveLength(1);

      const updatedWorkers = [createAgentWorker('agent-1'), createTerminalWorker('terminal-1')];

      act(() => {
        result.current.updateTabsFromSession(updatedWorkers);
      });

      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs[1]).toEqual({ id: 'terminal-1', workerType: 'terminal', name: 'Shell 1' });
    });
  });
});
