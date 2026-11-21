import { ChevronLeftIcon, ChevronRightIcon } from '../Icons';
import { MemoPanel } from './MemoPanel';
import { SessionTodosPanel } from './SessionTodosPanel';
import { SessionArtifactsPanel } from './SessionArtifactsPanel';
import { SessionBookmarksPanel } from './SessionBookmarksPanel';
import { useSessionSidePanelsState, type SessionSidePanelKey } from './hooks/useSessionSidePanelsState';

interface SessionSidePanelsProps {
  sessionId: string;
}

/**
 * Single owner of BOTH the Memo / To-do / Artifacts / Bookmarks open-section
 * record AND the shared rail chrome -- exactly one bordered column exists
 * on the page, with each section a row inside it.
 *
 * The sections form a single-open accordion: at most one is open at a time,
 * and opening one closes the one that was open (owner direction,
 * 2026-11-21; this replaced the earlier independent per-section flags).
 * `railOpen` is separate from which section is open: collapsing the rail is
 * a dedicated toggle button in its own row and never changes `openSection`.
 * When the rail is closed the column shrinks to a single narrow vertical bar
 * holding the section labels; clicking a label there reopens the rail with
 * that section open and every other closed (`openRailAndExpandSection`).
 *
 * The open rail is not one scroll container: the collapse button row is
 * `shrink-0` and only the wrapper around the sections scrolls, so the button
 * stays reachable at every scroll position.
 */
export function SessionSidePanels({ sessionId }: SessionSidePanelsProps) {
  const { railOpen, openSection, toggleRail, toggleSection, openRailAndExpandSection, expandSection } =
    useSessionSidePanelsState();

  const handleToggle = (key: SessionSidePanelKey) => () =>
    railOpen ? toggleSection(key) : openRailAndExpandSection(key);

  return (
    <div
      className={
        railOpen
          ? 'hidden md:flex flex-col w-80 border-l border-slate-700 bg-slate-800 shrink-0'
          : 'hidden md:flex flex-col items-center border-l border-slate-700 bg-slate-800 py-2 px-1 shrink-0'
      }
    >
      <div className={railOpen ? 'flex justify-end shrink-0 px-1 py-1' : 'flex justify-center py-1'}>
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
      <div className={railOpen ? 'flex flex-col flex-1 min-h-0 overflow-y-auto' : 'contents'}>
        <MemoPanel
          sessionId={sessionId}
          isExpanded={openSection === 'memo'}
          onToggleExpanded={handleToggle('memo')}
          // Only MemoPanel gets this: it's the only section whose
          // always-visible header control (Edit) can enter a content-editing
          // mode while the section is collapsed. Never needs to also open the
          // rail -- MemoPanel's own `compact` branch returns before rendering
          // the Edit button at all, so Edit is only reachable when
          // compact === false, i.e. railOpen === true already.
          onEnsureExpanded={() => expandSection('memo')}
          compact={!railOpen}
        />
        <SessionTodosPanel
          sessionId={sessionId}
          isExpanded={openSection === 'todos'}
          onToggleExpanded={handleToggle('todos')}
          compact={!railOpen}
        />
        <SessionArtifactsPanel
          sessionId={sessionId}
          isExpanded={openSection === 'artifacts'}
          onToggleExpanded={handleToggle('artifacts')}
          compact={!railOpen}
        />
        <SessionBookmarksPanel
          sessionId={sessionId}
          isExpanded={openSection === 'bookmarks'}
          onToggleExpanded={handleToggle('bookmarks')}
          compact={!railOpen}
        />
      </div>
    </div>
  );
}
