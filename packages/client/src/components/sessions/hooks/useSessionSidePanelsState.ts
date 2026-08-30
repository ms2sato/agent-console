import { useCallback, useState } from 'react';

export type SessionSidePanelKey = 'memo' | 'artifacts' | 'bookmarks';
export type SessionSidePanelsExpanded = Record<SessionSidePanelKey, boolean>;

const STORAGE_KEY = 'agent-console:session-side-panels-expanded';
const SECTION_KEYS: SessionSidePanelKey[] = ['memo', 'artifacts', 'bookmarks'];

// R3: unified default -- all closed, the rail at its minimum. Applies on
// first-ever load and whenever storage is unreadable/corrupt; NOT a choice
// about which section to open -- any later load restores whatever the user
// last had open.
const DEFAULT_EXPANDED: SessionSidePanelsExpanded = {
  memo: false,
  artifacts: false,
  bookmarks: false,
};

function isValidExpandedRecord(value: unknown): value is SessionSidePanelsExpanded {
  return (
    typeof value === 'object' &&
    value !== null &&
    SECTION_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === 'boolean')
  );
}

function getInitialExpanded(): SessionSidePanelsExpanded {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_EXPANDED;
    const parsed: unknown = JSON.parse(stored);
    return isValidExpandedRecord(parsed) ? parsed : DEFAULT_EXPANDED;
  } catch {
    return DEFAULT_EXPANDED;
  }
}

function persistExpanded(value: SessionSidePanelsExpanded): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore localStorage errors -- per-viewer convenience only.
  }
}

interface UseSessionSidePanelsStateReturn {
  expanded: SessionSidePanelsExpanded;
  toggleSection: (key: SessionSidePanelKey) => void;
}

/**
 * R2: ONE global localStorage key for the whole per-section record -- not
 * per-session keys (sessions accumulate; this is the user's working style,
 * not a session property).
 */
export function useSessionSidePanelsState(): UseSessionSidePanelsStateReturn {
  const [expanded, setExpanded] = useState<SessionSidePanelsExpanded>(getInitialExpanded);

  const toggleSection = useCallback((key: SessionSidePanelKey) => {
    setExpanded((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      persistExpanded(next);
      return next;
    });
  }, []);

  return { expanded, toggleSection };
}
