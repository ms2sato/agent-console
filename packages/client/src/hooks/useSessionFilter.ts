import { useState, useCallback, useMemo } from 'react';
import { useAuth } from '../lib/auth';

export type SessionFilterMode = 'all' | 'mine';

const STORAGE_KEY = 'session-filter-mode';

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
    return sessions.filter(s => s.createdBy === userId);
  }, [filterMode, isMultiUser, currentUser]);

  return useMemo(() => ({
    filterMode,
    setFilterMode,
    filterSessions,
  }), [filterMode, setFilterMode, filterSessions]);
}
