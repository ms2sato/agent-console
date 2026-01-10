import { useState, useCallback } from 'react';

/**
 * Generate a localStorage key for storing the visible file position
 */
function getStorageKey(sessionId: string, workerId: string): string {
  return `agent-console:diff-scroll:${sessionId}:${workerId}`;
}

/**
 * Read the stored visible file from localStorage
 * Exported so callers can read directly when needed (e.g., on fresh mount)
 */
export function getStoredVisibleFile(sessionId: string, workerId: string): string | null {
  try {
    const key = getStorageKey(sessionId, workerId);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Persist the visible file to localStorage
 */
function persistVisibleFile(sessionId: string, workerId: string, filePath: string | null): void {
  try {
    const key = getStorageKey(sessionId, workerId);
    if (filePath) {
      localStorage.setItem(key, filePath);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore localStorage errors
  }
}

interface UseDiffScrollPositionReturn {
  /** The currently visible file path for UI highlighting (null if none) */
  visibleFile: string | null;
  /** The file to scroll to on initial load (null after consumed) */
  initialScrollTarget: string | null;
  /** Called when a file becomes visible in the diff viewer (UI update only, no persistence) */
  setVisibleFile: (filePath: string) => void;
  /** Called when user explicitly selects a file (persists to localStorage) */
  saveScrollPosition: (filePath: string) => void;
  /** Called after the initial scroll has been performed */
  clearInitialScrollTarget: () => void;
  /** Re-read initialScrollTarget from localStorage (useful after mount) */
  refreshInitialScrollTarget: () => void;
}

/**
 * Hook for managing diff viewer scroll position with localStorage persistence.
 * Stores the visible file path and restores it when reopening the same worker.
 *
 * Important: Only saveScrollPosition persists to localStorage.
 * setVisibleFile is for UI updates only (e.g., from IntersectionObserver).
 * This prevents automatic scroll resets from overwriting user selections.
 */
export function useDiffScrollPosition(
  sessionId: string,
  workerId: string
): UseDiffScrollPositionReturn {
  // Read initial scroll target from localStorage once
  const [initialScrollTarget, setInitialScrollTarget] = useState<string | null>(() => {
    return getStoredVisibleFile(sessionId, workerId);
  });

  // Current visible file for UI highlighting (may be different from saved position)
  const [visibleFile, setVisibleFileState] = useState<string | null>(null);

  // Update visible file for UI only (no persistence)
  const setVisibleFile = useCallback((filePath: string) => {
    setVisibleFileState(filePath);
  }, []);

  // Save scroll position to localStorage (called on explicit user selection)
  const saveScrollPosition = useCallback(
    (filePath: string) => {
      setVisibleFileState(filePath);
      persistVisibleFile(sessionId, workerId, filePath);
    },
    [sessionId, workerId]
  );

  const clearInitialScrollTarget = useCallback(() => {
    setInitialScrollTarget(null);
  }, []);

  // Re-read from localStorage and update state
  // Useful when the component needs to refresh the target (e.g., after confirming mount)
  const refreshInitialScrollTarget = useCallback(() => {
    const stored = getStoredVisibleFile(sessionId, workerId);
    if (stored) {
      setInitialScrollTarget(stored);
    }
  }, [sessionId, workerId]);

  return {
    visibleFile,
    initialScrollTarget,
    setVisibleFile,
    saveScrollPosition,
    clearInitialScrollTarget,
    refreshInitialScrollTarget,
  };
}
