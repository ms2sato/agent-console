import { useState, useCallback } from 'react';

const SIDEBAR_COLLAPSED_KEY = 'agent-console:sidebar-collapsed';
const SIDEBAR_WIDTH_KEY = 'agent-console:sidebar-width';

// Width constants
export const SIDEBAR_MIN_WIDTH = 150;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 224; // w-56 equivalent
export const SIDEBAR_COLLAPSED_WIDTH = 48; // w-12 equivalent

function getInitialCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return stored ? JSON.parse(stored) : false;
  } catch {
    return false;
  }
}

function getInitialWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const width = JSON.parse(stored);
      // Ensure width is within valid bounds
      return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
    }
    return SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function persistCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
  } catch {
    // Ignore localStorage errors
  }
}

function persistWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, JSON.stringify(width));
  } catch {
    // Ignore localStorage errors
  }
}

interface UseSidebarStateReturn {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
  width: number;
  setWidth: (width: number) => void;
}

/**
 * Hook for managing sidebar collapsed state and width with localStorage persistence.
 * Initializes from localStorage on mount and persists changes.
 */
export function useSidebarState(): UseSidebarStateReturn {
  const [collapsed, setCollapsedState] = useState(getInitialCollapsed);
  const [width, setWidthState] = useState(getInitialWidth);

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

  const setWidth = useCallback((value: number) => {
    const clampedWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, value));
    setWidthState(clampedWidth);
    persistWidth(clampedWidth);
  }, []);

  return { collapsed, setCollapsed, toggle, width, setWidth };
}
