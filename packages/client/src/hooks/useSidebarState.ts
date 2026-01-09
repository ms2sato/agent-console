import { useState, useCallback } from 'react';

const SIDEBAR_COLLAPSED_KEY = 'agent-console:sidebar-collapsed';

function getInitialCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return stored ? JSON.parse(stored) : false;
  } catch {
    return false;
  }
}

function persistCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
  } catch {
    // Ignore localStorage errors
  }
}

interface UseSidebarStateReturn {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
}

/**
 * Hook for managing sidebar collapsed state with localStorage persistence.
 * Initializes from localStorage on mount and persists changes.
 */
export function useSidebarState(): UseSidebarStateReturn {
  const [collapsed, setCollapsedState] = useState(getInitialCollapsed);

  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    persistCollapsed(value);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      persistCollapsed(next);
      return next;
    });
  }, []);

  return { collapsed, setCollapsed, toggle };
}
