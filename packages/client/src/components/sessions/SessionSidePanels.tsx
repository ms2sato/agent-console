import { MemoPanel } from './MemoPanel';
import { SessionArtifactsPanel } from './SessionArtifactsPanel';
import { SessionBookmarksPanel } from './SessionBookmarksPanel';
import { useSessionSidePanelsState } from './hooks/useSessionSidePanelsState';

interface SessionSidePanelsProps {
  sessionId: string;
}

/**
 * Single owner of BOTH the Memo / Artifacts / Bookmarks expanded-state
 * record (R1a) AND the shared rail chrome (R1b/R1c) -- exactly one bordered
 * column exists on the page, with each section a row inside it. When every
 * section is collapsed the column shrinks to a single narrow vertical bar
 * holding the section labels (R1d); as soon as any section is expanded the
 * column widens into a normal accordion, with each section a header row and
 * its body stacked directly underneath when open. Multi-open stays
 * unrestricted -- only the duplicated per-panel chrome is removed.
 */
export function SessionSidePanels({ sessionId }: SessionSidePanelsProps) {
  const { expanded, toggleSection } = useSessionSidePanelsState();
  const anyExpanded = expanded.memo || expanded.artifacts || expanded.bookmarks;

  return (
    <div
      className={
        anyExpanded
          ? 'hidden md:flex flex-col w-80 border-l border-slate-700 bg-slate-800 shrink-0 overflow-y-auto'
          : 'hidden md:flex flex-col items-center border-l border-slate-700 bg-slate-800 py-2 px-1 shrink-0'
      }
    >
      <MemoPanel
        sessionId={sessionId}
        isExpanded={expanded.memo}
        onToggleExpanded={() => toggleSection('memo')}
        compact={!anyExpanded}
      />
      <SessionArtifactsPanel
        sessionId={sessionId}
        isExpanded={expanded.artifacts}
        onToggleExpanded={() => toggleSection('artifacts')}
        compact={!anyExpanded}
      />
      <SessionBookmarksPanel
        sessionId={sessionId}
        isExpanded={expanded.bookmarks}
        onToggleExpanded={() => toggleSection('bookmarks')}
        compact={!anyExpanded}
      />
    </div>
  );
}
