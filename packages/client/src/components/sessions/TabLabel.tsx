import { useEffect, useRef, useState, type ReactNode } from 'react';
import { renameWorker } from '../../lib/api';
import { EditIcon } from '../Icons';

interface TabLabelProps {
  sessionId: string;
  workerId: string;
  name: string;
  active: boolean;
  /** Extra classes for the tab button (padding depends on the close control). */
  buttonClassName: string;
  /** Leading content of the tab button (the status dot or icon). */
  children?: ReactNode;
  onSelect: () => void;
  onError: (message: string) => void;
  /**
   * Called after the tab has left edit mode (committed or cancelled), once the
   * DOM already shows the final label. The input and the label have different
   * widths, so a parent that positions this tab (a scrolling tab bar) can only
   * measure the settled layout from here.
   */
  onEditEnd?: () => void;
}

/**
 * One worker tab's activator plus its inline rename control.
 *
 * Renders, as siblings (never nested -- a button inside the tab button is
 * invalid and changes the tab's accessible name): the `role="tab"` button
 * (or, while editing, the name input in its place) and the hover pencil.
 *
 * There is no optimistic state. The input stays until the PATCH settles; a
 * successful rename reaches the tab through the server's session-updated
 * broadcast, so `name` simply changes underneath this component.
 */
export function TabLabel({
  sessionId,
  workerId,
  name,
  active,
  buttonClassName,
  children,
  onSelect,
  onError,
  onEditEnd,
}: TabLabelProps) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState(name);
  // True once the current edit was committed or cancelled, so Enter followed
  // by the blur caused by unmounting the input cannot commit twice.
  const settledRef = useRef(true);
  const refocusTabRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);

  const wasEditingRef = useRef(false);

  useEffect(() => {
    const wasEditing = wasEditingRef.current;
    wasEditingRef.current = editing;
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (refocusTabRef.current) {
      refocusTabRef.current = false;
      // preventScroll: the renamed tab may sit in a horizontally scrolling bar,
      // and a default focus() would scroll it, undoing SessionPage's own
      // scroll of the selected tab into view.
      tabRef.current?.focus({ preventScroll: true });
    }
    if (wasEditing && !editing) onEditEnd?.();
  }, [editing]);

  const startEdit = () => {
    settledRef.current = false;
    setDraft(name);
    setEditing(true);
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    refocusTabRef.current = true;
    setEditing(false);
  };

  const commit = async (refocusTab: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    refocusTabRef.current = refocusTab;
    const next = draft.trim();
    if (next === '' || next === name) {
      setEditing(false);
      return;
    }
    setPending(true);
    try {
      await renameWorker(sessionId, workerId, next);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Failed to rename worker');
    } finally {
      setPending(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        aria-label="Tab name"
        value={draft}
        readOnly={pending}
        maxLength={64}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className="mx-2 my-1 w-32 rounded border border-slate-500 bg-slate-800 px-1 py-0.5 text-sm text-white"
      />
    );
  }

  return (
    <>
      <button
        ref={tabRef}
        role="tab"
        id={`worker-tab-${workerId}`}
        aria-selected={active}
        aria-controls={`worker-tabpanel-${workerId}`}
        tabIndex={active ? 0 : -1}
        onClick={onSelect}
        onDoubleClick={startEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault();
            refocusTabRef.current = true;
            startEdit();
          }
        }}
        className={buttonClassName}
      >
        {children}
        {name}
      </button>
      <button
        type="button"
        aria-label={`Rename ${name}`}
        tabIndex={active ? 0 : -1}
        onClick={startEdit}
        className="px-1 py-2 text-gray-500 opacity-0 hover:text-white focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 cursor-pointer bg-transparent border-none leading-none"
      >
        <EditIcon className="w-3 h-3" />
      </button>
    </>
  );
}
