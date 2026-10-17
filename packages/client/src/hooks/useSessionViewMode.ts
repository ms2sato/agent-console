import { useState, useCallback } from 'react';

export type SessionViewMode = 'flat' | 'tree';

export const STORAGE_KEY = 'session-view-mode';

function readStoredViewMode(): SessionViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'flat' || stored === 'tree') {
      return stored;
    }
  } catch {
    // localStorage may be unavailable
  }
  return 'flat';
}

export function useSessionViewMode(): {
  viewMode: SessionViewMode;
  setViewMode: (mode: SessionViewMode) => void;
} {
  const [viewMode, setViewModeState] = useState<SessionViewMode>(readStoredViewMode);

  const setViewMode = useCallback((mode: SessionViewMode) => {
    setViewModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  return { viewMode, setViewMode };
}
