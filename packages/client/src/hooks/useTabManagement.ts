import { useState, useEffect, useCallback, useRef, startTransition } from 'react';
import { createWorker, deleteWorker } from '../lib/api';
import { getDefaultTabId, isWorkerIdReady } from '../components/sessions/sessionTabRouting';
import type { Worker, AgentActivityState } from '@agent-console/shared';

export interface Tab {
  id: string;
  workerType: 'agent' | 'terminal' | 'git-diff';
  name: string;
}

// Convert workers to tabs
function workersToTabs(workers: Worker[]): Tab[] {
  return workers.map(worker => ({
    id: worker.id,
    workerType: worker.type,
    name: worker.name,
  }));
}

// Find the first agent worker in the list
function findFirstAgentWorker(workers: Worker[]): Worker | undefined {
  return workers.find(w => w.type === 'agent');
}

interface UseTabManagementOptions {
  sessionId: string;
  /** Whether the session is in 'active' state and has workers ready */
  activeSession: { workers: Worker[] } | null;
  urlWorkerId?: string;
  navigateToWorker: (workerId: string, replace?: boolean) => void;
  navigateToSession: () => void;
  showError: (title: string, message: string) => void;
  workerActivityStates: Record<string, AgentActivityState>;
  setActivityState: (state: AgentActivityState) => void;
  setExitInfo: (info: { code: number; signal: string | null } | undefined) => void;
}

export interface UseTabManagementResult {
  tabs: Tab[];
  activeTabId: string | null;
  activeTabIdRef: React.RefObject<string | null>;
  addTerminalTab: () => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  handleTabClick: (tabId: string) => void;
  updateTabsFromSession: (workers: Worker[]) => void;
}

export function useTabManagement({
  sessionId,
  activeSession,
  urlWorkerId,
  navigateToWorker,
  navigateToSession,
  showError,
  workerActivityStates,
  setActivityState,
  setExitInfo,
}: UseTabManagementOptions): UseTabManagementResult {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const pendingWorkerIdRef = useRef<string | null>(null);

  // Track active tab for app-websocket activity filtering
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;

  // Initialize tabs when session becomes active
  useEffect(() => {
    if (activeSession && tabs.length === 0) {
      const workers = activeSession.workers;
      const newTabs = workersToTabs(workers);
      setTabs(newTabs);

      // Determine initial active tab:
      // 1. If urlWorkerId is valid (exists in workers), use it
      // 2. Otherwise, redirect to default (first agent or first tab)
      const urlWorkerExists = urlWorkerId && workers.some(w => w.id === urlWorkerId);

      if (urlWorkerExists) {
        setActiveTabId(urlWorkerId);
      } else {
        // Calculate default tab
        const defaultTabId = findFirstAgentWorker(workers)?.id ?? newTabs[0]?.id ?? null;
        setActiveTabId(defaultTabId);

        // Redirect to the default worker URL
        if (defaultTabId) {
          navigateToWorker(defaultTabId, true);
        }
      }
    }
  }, [activeSession, tabs.length, urlWorkerId, navigateToWorker]);

  // Handle URL workerId changes (user navigates directly to URL or uses back/forward)
  useEffect(() => {
    // Only handle when tabs are already initialized
    if (tabs.length === 0 || !activeSession) return;

    const defaultTabId = getDefaultTabId(tabs);

    if (urlWorkerId) {
      // Check if the URL workerId is valid
      if (isWorkerIdReady(urlWorkerId, tabs, pendingWorkerIdRef.current)) {
        // Valid workerId - sync activeTabId
        if (activeTabId !== urlWorkerId) {
          setActiveTabId(urlWorkerId);
        }
        if (pendingWorkerIdRef.current === urlWorkerId) {
          pendingWorkerIdRef.current = null;
        }
      } else {
        // Invalid workerId - redirect to session base
        navigateToSession();
      }
    } else {
      // No workerId in URL - redirect to default worker
      if (defaultTabId) {
        navigateToWorker(defaultTabId, true);
      }
    }
  }, [urlWorkerId, tabs, activeSession, activeTabId, navigateToSession, navigateToWorker]);

  // Add a new terminal (shell) tab
  const addTerminalTab = useCallback(async () => {
    if (!activeSession) return;

    try {
      const { worker } = await createWorker(sessionId, {
        type: 'terminal',
        name: `Shell ${tabs.filter(t => t.workerType === 'terminal').length + 1}`,
      });

      const newTab: Tab = {
        id: worker.id,
        workerType: 'terminal',
        name: worker.name,
      };
      pendingWorkerIdRef.current = worker.id;
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(worker.id);
      navigateToWorker(worker.id);
    } catch (error) {
      console.error('Failed to create terminal worker:', error);
      showError('Failed to Create Worker', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [activeSession, sessionId, tabs, navigateToWorker, showError]);

  // Close a tab (delete worker)
  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Don't allow closing agent or git-diff workers (fixed tabs)
    // Only terminal workers can be closed
    if (tab.workerType === 'agent' || tab.workerType === 'git-diff') return;

    try {
      await deleteWorker(sessionId, tabId);

      // Calculate new tabs and new active tab
      const newTabs = tabs.filter(t => t.id !== tabId);
      let newActiveTabId = activeTabId;

      // If closing the active tab, switch to first agent or first remaining tab
      if (activeTabId === tabId) {
        const firstAgent = newTabs.find(t => t.workerType === 'agent');
        newActiveTabId = firstAgent?.id ?? newTabs[0]?.id ?? null;
      }

      setTabs(newTabs);
      if (activeTabId === tabId && newActiveTabId) {
        setActiveTabId(newActiveTabId);
        navigateToWorker(newActiveTabId);
      }
    } catch (error) {
      console.error('Failed to delete worker:', error);
    }
  }, [sessionId, tabs, activeTabId, navigateToWorker]);

  const handleTabClick = useCallback((tabId: string) => {
    // Use startTransition to mark this update as non-urgent
    // This keeps the UI responsive during the state update
    // Status resets are inside startTransition to render atomically with tab switch
    startTransition(() => {
      const knownState = workerActivityStates[tabId];
      setActivityState(knownState ?? 'unknown');
      setExitInfo(undefined);
      setActiveTabId(tabId);
      navigateToWorker(tabId);
    });
  }, [workerActivityStates, setActivityState, setExitInfo, navigateToWorker]);

  const updateTabsFromSession = useCallback((workers: Worker[]) => {
    const newTabs = workersToTabs(workers);
    setTabs(newTabs);
  }, []);

  return {
    tabs,
    activeTabId,
    activeTabIdRef,
    addTerminalTab,
    closeTab,
    handleTabClick,
    updateTabsFromSession,
  };
}
