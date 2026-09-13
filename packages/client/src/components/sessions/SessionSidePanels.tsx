import { ChevronLeftIcon, ChevronRightIcon } from '../Icons';
import { MemoPanel } from './MemoPanel';
import { SessionArtifactsPanel } from './SessionArtifactsPanel';
import { SessionBookmarksPanel } from './SessionBookmarksPanel';
import { useSessionSidePanelsState, type SessionSidePanelKey } from './hooks/useSessionSidePanelsState';

interface SessionSidePanelsProps {
  sessionId: string;
}

/**
 * Single owner of BOTH the Memo / Artifacts / Bookmarks expanded-state
 * record AND the shared rail chrome -- exactly one bordered column exists
 * on the page, with each section a row inside it.
 *
 * `railOpen` and each section's `expanded` flag are independent: collapsing
 * the rail is a dedicated toggle button in its own row, separate from any
 * section's own open/closed state, and it never mutates
 * `expanded`. When the rail is closed the column shrinks to a single narrow
 * vertical bar holding the section labels; clicking a section's label there
 * reopens the rail AND expands that section in one step
 * (`openRailAndExpandSection`) without disturbing any other section's
 * state. When the rail is open, each section behaves like an ordinary
 * accordion header with its body stacked directly underneath when
 * expanded. Multi-open stays unrestricted -- only the duplicated per-panel
 * chrome is removed.
 */
export function SessionSidePanels({ sessionId }: SessionSidePanelsProps) {
  const { railOpen, expanded, toggleRail, toggleSection, openRailAndExpandSection } = useSessionSidePanelsState();

  const handleToggle = (key: SessionSidePanelKey) => () =>
    railOpen ? toggleSection(key) : openRailAndExpandSection(key);

  return (
    <div
      className={
        railOpen
          ? 'hidden md:flex flex-col w-80 border-l border-slate-700 bg-slate-800 shrink-0 overflow-y-auto'
          : 'hidden md:flex flex-col items-center border-l border-slate-700 bg-slate-800 py-2 px-1 shrink-0'
      }
    >
      <div className={railOpen ? 'flex justify-end px-1 py-1' : 'flex justify-center py-1'}>
        <button
          type="button"
          onClick={toggleRail}
          aria-expanded={railOpen}
          aria-label={railOpen ? 'Collapse side panel' : 'Expand side panel'}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1"
        >
          {railOpen ? <ChevronRightIcon className="w-4 h-4" /> : <ChevronLeftIcon className="w-4 h-4" />}
        </button>
      </div>
      <MemoPanel
        sessionId={sessionId}
        isExpanded={expanded.memo}
        onToggleExpanded={handleToggle('memo')}
        compact={!railOpen}
      />
      <SessionArtifactsPanel
        sessionId={sessionId}
        isExpanded={expanded.artifacts}
        onToggleExpanded={handleToggle('artifacts')}
        compact={!railOpen}
      />
      <SessionBookmarksPanel
        sessionId={sessionId}
        isExpanded={expanded.bookmarks}
        onToggleExpanded={handleToggle('bookmarks')}
        compact={!railOpen}
      />
    </div>
  );
}
