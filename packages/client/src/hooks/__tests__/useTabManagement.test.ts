import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock API calls
const mockCreateWorker = mock(() =>
  Promise.resolve({
    worker: { id: 'new-terminal-1', type: 'terminal' as const, name: 'Shell 1', createdAt: new Date().toISOString(), activated: true },
  })
);
const mockDeleteWorker = mock(() => Promise.resolve());

mock.module('../../lib/api', () => ({
  createWorker: mockCreateWorker,
  deleteWorker: mockDeleteWorker,
}));

import { renderHook, act } from '@testing-library/react';
import { useTabManagement } from '../useTabManagement';
import type { Worker, AgentActivityState } from '@agent-console/shared';

type UseTabManagementOptions = Parameters<typeof useTabManagement>[0];

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

describe('useTabManagement', () => {
  beforeEach(() => {
    mockCreateWorker.mockClear();
    mockDeleteWorker.mockClear();
    // Reset createWorker to default return value
    mockCreateWorker.mockImplementation(() =>
      Promise.resolve({
        worker: { id: 'new-terminal-1', type: 'terminal' as const, name: 'Shell 1', createdAt: new Date().toISOString(), activated: true },
      })
    );
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

      expect(mockCreateWorker).toHaveBeenCalledWith('session-1', {
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

      expect(mockDeleteWorker).toHaveBeenCalledWith('session-1', 'terminal-1');
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

      expect(mockDeleteWorker).not.toHaveBeenCalled();
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

      expect(mockDeleteWorker).not.toHaveBeenCalled();
      expect(result.current.tabs).toHaveLength(2);
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
