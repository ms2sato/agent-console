import { useEffect, useRef } from 'react';
import { MemoPanel } from './MemoPanel';
import { SessionArtifactsPanel } from './SessionArtifactsPanel';
import { SessionBookmarksPanel } from './SessionBookmarksPanel';
import { useSessionSidePanelsState } from './hooks/useSessionSidePanelsState';

interface SessionSidePanelsDrawerProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Mobile counterpart of `SessionSidePanels`: on viewports below 768px the
 * rail is unrendered entirely (`hidden md:flex` never shows it), so the
 * Memo / Artifacts / Bookmarks sections need a separate, right-anchored
 * overlay entry point. This drawer shares the exact same `expanded` record
 * through the exact same `useSessionSidePanelsState` hook and storage key
 * as the rail, so desktop and mobile never diverge on which sections a
 * viewer left open.
 *
 * `railOpen` is a desktop-only concept -- the rail's own collapse/expand
 * chrome for its narrow-vs-wide column layout. The drawer has no
 * equivalent narrow state (it's either fully open or fully closed via the
 * `open` prop), so it never reads or writes `railOpen`.
 *
 * `open` is transient and owned by the caller (`SessionPage`'s own
 * `useState`), not persisted here -- see `SessionPage.tsx` for why a
 * persisted overlay would be wrong (it would reopen on every navigation).
 *
 * `compact` is always `false`: this is a modal overlay, not a shared rail
 * that can also collapse to a narrow strip, so there is no compact
 * form to render, and MemoPanel's Edit button (only reachable when
 * `compact === false`) stays reachable on a phone.
 *
 * Structurally modeled on `MobileSidebarDrawer` (same three effects:
 * Escape-to-close, body scroll lock, focus save/restore), but
 * right-anchored instead of left-anchored, and with no header/close
 * button of its own -- the panels' own `border-b` separators are the only
 * internal chrome, since the drawer is already a bordered overlay and
 * doesn't need a second nested bordered column like the desktop rail.
 */
export function SessionSidePanelsDrawer({ sessionId, open, onClose }: SessionSidePanelsDrawerProps) {
  const savedFocusRef = useRef<Element | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const { expanded, toggleSection, expandSection } = useSessionSidePanelsState();

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      savedFocusRef.current = document.activeElement;
      const firstFocusable = drawerRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    } else if (savedFocusRef.current instanceof HTMLElement) {
      savedFocusRef.current.focus();
      savedFocusRef.current = null;
    }
  }, [open]);

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal={open || undefined}
        aria-hidden={!open}
        aria-label="Session panels"
        className={`fixed top-0 right-0 z-50 h-full w-80 max-w-[100vw] flex flex-col overflow-y-auto bg-slate-800 border-l border-slate-700 transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <MemoPanel
          sessionId={sessionId}
          isExpanded={expanded.memo}
          onToggleExpanded={() => toggleSection('memo')}
          onEnsureExpanded={() => expandSection('memo')}
          compact={false}
        />
        <SessionArtifactsPanel
          sessionId={sessionId}
          isExpanded={expanded.artifacts}
          onToggleExpanded={() => toggleSection('artifacts')}
          compact={false}
        />
        <SessionBookmarksPanel
          sessionId={sessionId}
          isExpanded={expanded.bookmarks}
          onToggleExpanded={() => toggleSection('bookmarks')}
          compact={false}
        />
      </div>
    </>
  );
}
