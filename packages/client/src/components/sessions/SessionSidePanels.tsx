import { MemoPanel } from './MemoPanel';
import { SessionArtifactsPanel } from './SessionArtifactsPanel';
import { SessionBookmarksPanel } from './SessionBookmarksPanel';
import { useSessionSidePanelsState } from './hooks/useSessionSidePanelsState';

interface SessionSidePanelsProps {
  sessionId: string;
}

/**
 * Single owner of the Memo / Artifacts / Bookmarks side-panel expanded state.
 * Each panel receives its slice of the shared record and has lost its own
 * isExpanded state entirely -- the prop replaces it.
 */
export function SessionSidePanels({ sessionId }: SessionSidePanelsProps) {
  const { expanded, toggleSection } = useSessionSidePanelsState();

  return (
    <>
      <MemoPanel
        sessionId={sessionId}
        isExpanded={expanded.memo}
        onToggleExpanded={() => toggleSection('memo')}
      />
      <SessionArtifactsPanel
        sessionId={sessionId}
        isExpanded={expanded.artifacts}
        onToggleExpanded={() => toggleSection('artifacts')}
      />
      <SessionBookmarksPanel
        sessionId={sessionId}
        isExpanded={expanded.bookmarks}
        onToggleExpanded={() => toggleSection('bookmarks')}
      />
    </>
  );
}
