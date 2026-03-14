import { useState, useCallback } from 'react';
import { useAuth } from '../lib/auth';
import type { SessionFilterMode } from '../types/session-filter';

export type { SessionFilterMode };

export const STORAGE_KEY = 'session-filter-mode';

/**
 * Clear the stored filter mode from localStorage.
 * Used during logout to prevent preference leakage between users.
 */
export function clearStoredFilterMode(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore localStorage errors
  }
}

function readStoredFilterMode(): SessionFilterMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'all' || stored === 'mine') {
      return stored;
    }
  } catch {
    // localStorage may be unavailable
  }
  return 'all';
}

export function useSessionFilter(): {
  filterMode: SessionFilterMode;
  setFilterMode: (mode: SessionFilterMode) => void;
  filterSessions: <T extends { createdBy?: string }>(sessions: T[]) => T[];
} {
  const { currentUser, isMultiUser } = useAuth();
  const [filterMode, setFilterModeState] = useState<SessionFilterMode>(readStoredFilterMode);

  const setFilterMode = useCallback((mode: SessionFilterMode) => {
    setFilterModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  const filterSessions = useCallback(<T extends { createdBy?: string }>(sessions: T[]): T[] => {
    if (!isMultiUser) {
      return sessions;
    }
    if (filterMode !== 'mine') {
      return sessions;
    }
    const userId = currentUser?.id;
    if (!userId) {
      return sessions;
    }
    return sessions.filter(s => s.createdBy === userId || s.createdBy === undefined);
  }, [filterMode, isMultiUser, currentUser]);

  return { filterMode, setFilterMode, filterSessions };
}
