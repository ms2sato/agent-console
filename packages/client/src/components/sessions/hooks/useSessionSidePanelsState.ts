import { useCallback, useState } from 'react';

export type SessionSidePanelKey = 'memo' | 'todos' | 'artifacts' | 'bookmarks';
export type SessionSidePanelsExpanded = Record<SessionSidePanelKey, boolean>;

// At most one section is open at a time, so the open section is ONE value
// rather than a flag per section: a state with two open sections is not
// representable (owner direction, 2026-11-21).
interface SessionSidePanelsRecord {
  railOpen: boolean;
  openSection: SessionSidePanelKey | null;
}

// v3 stores `{ railOpen, openSection }`. The v2 record (`railOpen` plus an
// `expanded` flag per section) is read once as a fallback and converted, but
// never written and never removed: an older tab still running the previous
// code reads it. Older keys (`...-expanded`) stay unread -- there is no
// migration path from the old all-closed-by-default record.
const STORAGE_KEY = 'agent-console:session-side-panels-v3';
const LEGACY_STORAGE_KEY = 'agent-console:session-side-panels-v2';
const SECTION_KEYS: SessionSidePanelKey[] = ['memo', 'todos', 'artifacts', 'bookmarks'];
// Sections added after the first release of the v2 shape. A v2 record
// persisted before such a section existed stays valid (the section reads as
// expanded) rather than being discarded.
const SECTIONS_ADDED_LATER: SessionSidePanelKey[] = ['todos'];

// Default: rail closed, Memo is the section that shows when the rail is
// opened. Applies on first-ever load and whenever storage is unreadable or
// corrupt.
const DEFAULT_RECORD: SessionSidePanelsRecord = {
  railOpen: false,
  openSection: 'memo',
};

interface LegacyRecord {
  railOpen: boolean;
  expanded: SessionSidePanelsExpanded;
}

function isValidExpandedRecord(value: unknown): value is SessionSidePanelsExpanded {
  return (
    typeof value === 'object' &&
    value !== null &&
    SECTION_KEYS.every((key) => {
      const entry = (value as Record<string, unknown>)[key];
      return typeof entry === 'boolean' || (entry === undefined && SECTIONS_ADDED_LATER.includes(key));
    })
  );
}

function isValidRecord(value: unknown): value is LegacyRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).railOpen === 'boolean' &&
    isValidExpandedRecord((value as Record<string, unknown>).expanded)
  );
}

function isValidV3Record(value: unknown): value is SessionSidePanelsRecord {
  if (typeof value !== 'object' || value === null) return false;
  const { railOpen, openSection } = value as Record<string, unknown>;
  return (
    typeof railOpen === 'boolean' &&
    (openSection === null || SECTION_KEYS.some((key) => key === openSection))
  );
}

function convertLegacyRecord(legacy: LegacyRecord): SessionSidePanelsRecord {
  // A section missing from the record reads as expanded (SECTIONS_ADDED_LATER).
  const first = SECTION_KEYS.find((key) => legacy.expanded[key] ?? SECTIONS_ADDED_LATER.includes(key)) ?? null;
  return { railOpen: legacy.railOpen, openSection: first };
}

// One try per key: an unreadable or malformed record under one key must not
// stop the next key from being tried.
function readStored(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return undefined;
    return JSON.parse(stored);
  } catch {
    return undefined;
  }
}

function getInitialRecord(): SessionSidePanelsRecord {
  const current = readStored(STORAGE_KEY);
  if (isValidV3Record(current)) return { railOpen: current.railOpen, openSection: current.openSection };
  const legacy = readStored(LEGACY_STORAGE_KEY);
  if (isValidRecord(legacy)) return convertLegacyRecord(legacy);
  return DEFAULT_RECORD;
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
  openSection: SessionSidePanelKey | null;
  toggleRail: () => void;
  toggleSection: (key: SessionSidePanelKey) => void;
  openRailAndExpandSection: (key: SessionSidePanelKey) => void;
  expandSection: (key: SessionSidePanelKey) => void;
}

/**
 * ONE global localStorage key for the whole record -- not per-session keys
 * (sessions accumulate; this is the user's working style, not a session
 * property).
 *
 * Single-open accordion (owner direction, 2026-11-21): `openSection` holds
 * the one open section or `null`. Collapsing the rail never touches
 * `openSection`, so reopening the rail shows the section that was open.
 * `openRailAndExpandSection` sets both in a single state update so an
 * already-open section is not toggled back off.
 */
export function useSessionSidePanelsState(): UseSessionSidePanelsStateReturn {
  const [record, setRecord] = useState<SessionSidePanelsRecord>(getInitialRecord);

  const update = useCallback((change: (prev: SessionSidePanelsRecord) => SessionSidePanelsRecord) => {
    setRecord((prev) => {
      const next = change(prev);
      persistRecord(next);
      return next;
    });
  }, []);

  const toggleRail = useCallback(() => {
    update((prev) => ({ ...prev, railOpen: !prev.railOpen }));
  }, [update]);

  const toggleSection = useCallback(
    (key: SessionSidePanelKey) => {
      update((prev) => ({ ...prev, openSection: prev.openSection === key ? null : key }));
    },
    [update],
  );

  const openRailAndExpandSection = useCallback(
    (key: SessionSidePanelKey) => {
      update(() => ({ railOpen: true, openSection: key }));
    },
    [update],
  );

  // One-directional: never closes `key`, but does close any other section.
  // Used when an always-visible header control (e.g. MemoPanel's Edit button)
  // enters a content-editing mode that must be visible.
  const expandSection = useCallback(
    (key: SessionSidePanelKey) => {
      update((prev) => ({ ...prev, openSection: key }));
    },
    [update],
  );

  return {
    railOpen: record.railOpen,
    openSection: record.openSection,
    toggleRail,
    toggleSection,
    openRailAndExpandSection,
    expandSection,
  };
}
