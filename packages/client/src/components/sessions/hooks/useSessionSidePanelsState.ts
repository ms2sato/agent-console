import { useCallback, useState } from 'react';

export type SessionSidePanelKey = 'memo' | 'artifacts' | 'bookmarks';
export type SessionSidePanelsExpanded = Record<SessionSidePanelKey, boolean>;

interface SessionSidePanelsRecord {
  railOpen: boolean;
  expanded: SessionSidePanelsExpanded;
}

// Bumped from `agent-console:session-side-panels-expanded`: the persisted
// shape gained `railOpen` as an independent top-level flag (the side rail's
// ordinary-accordion refactor). The old key is intentionally never read --
// there is no migration path from the old all-closed-by-default
// per-section-only record to this one, and reverting to the old key would
// silently reintroduce the old default.
const STORAGE_KEY = 'agent-console:session-side-panels-v2';
const SECTION_KEYS: SessionSidePanelKey[] = ['memo', 'artifacts', 'bookmarks'];

// R3': unified default -- rail open, every section expanded. Applies on
// first-ever load and whenever storage is unreadable/corrupt; NOT a choice
// about which section to open on a later load -- any later load restores
// whatever the user last had open.
const DEFAULT_RECORD: SessionSidePanelsRecord = {
  railOpen: true,
  expanded: {
    memo: true,
    artifacts: true,
    bookmarks: true,
  },
};

function isValidExpandedRecord(value: unknown): value is SessionSidePanelsExpanded {
  return (
    typeof value === 'object' &&
    value !== null &&
    SECTION_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === 'boolean')
  );
}

function isValidRecord(value: unknown): value is SessionSidePanelsRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).railOpen === 'boolean' &&
    isValidExpandedRecord((value as Record<string, unknown>).expanded)
  );
}

function getInitialRecord(): SessionSidePanelsRecord {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_RECORD;
    const parsed: unknown = JSON.parse(stored);
    return isValidRecord(parsed) ? parsed : DEFAULT_RECORD;
  } catch {
    return DEFAULT_RECORD;
  }
}

function persistRecord(value: SessionSidePanelsRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore localStorage errors -- per-viewer convenience only.
  }
}

interface UseSessionSidePanelsStateReturn {
  railOpen: boolean;
  expanded: SessionSidePanelsExpanded;
  toggleRail: () => void;
  toggleSection: (key: SessionSidePanelKey) => void;
  openRailAndExpandSection: (key: SessionSidePanelKey) => void;
}

/**
 * R2: ONE global localStorage key for the whole record -- not per-session
 * keys (sessions accumulate; this is the user's working style, not a
 * session property).
 *
 * `railOpen` and `expanded` are independent flags: collapsing the rail never
 * touches which sections are expanded, and toggling a section never touches
 * whether the rail is open. `openRailAndExpandSection` is the one operation
 * that sets both at once (R5a -- clicking a collapsed section's compact
 * label reopens the rail with that section already expanded), and it does
 * so via a single state update so an already-expanded section isn't
 * incorrectly toggled back off.
 */
export function useSessionSidePanelsState(): UseSessionSidePanelsStateReturn {
  const [record, setRecord] = useState<SessionSidePanelsRecord>(getInitialRecord);

  const toggleRail = useCallback(() => {
    setRecord((prev) => {
      const next: SessionSidePanelsRecord = { ...prev, railOpen: !prev.railOpen };
      persistRecord(next);
      return next;
    });
  }, []);

  const toggleSection = useCallback((key: SessionSidePanelKey) => {
    setRecord((prev) => {
      const next: SessionSidePanelsRecord = {
        ...prev,
        expanded: { ...prev.expanded, [key]: !prev.expanded[key] },
      };
      persistRecord(next);
      return next;
    });
  }, []);

  const openRailAndExpandSection = useCallback((key: SessionSidePanelKey) => {
    setRecord((prev) => {
      const next: SessionSidePanelsRecord = {
        railOpen: true,
        expanded: { ...prev.expanded, [key]: true },
      };
      persistRecord(next);
      return next;
    });
  }, []);

  return {
    railOpen: record.railOpen,
    expanded: record.expanded,
    toggleRail,
    toggleSection,
    openRailAndExpandSection,
  };
}
