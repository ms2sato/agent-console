import { useCallback, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSessionMemo, updateSessionMemo } from '../../lib/api';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { sessionKeys } from '../../lib/query-keys';

interface MemoPanelProps {
  sessionId: string;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  compact: boolean;
}

type MemoPanelMode = 'view' | 'edit';

export function MemoPanel({ sessionId, isExpanded, onToggleExpanded, compact }: MemoPanelProps) {
  const queryClient = useQueryClient();

  const { data: content, isPending } = useQuery({
    queryKey: sessionKeys.memo(sessionId),
    queryFn: () => fetchSessionMemo(sessionId),
  });

  const [mode, setMode] = useState<MemoPanelMode>('view');
  const [draft, setDraft] = useState('');
  const [hasIncomingUpdateWhileEditing, setHasIncomingUpdateWhileEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The baseline draft was seeded with, for the Escape-cancel comparison
  // (R2). Deliberately a ref, not state: it is never rendered, only read
  // inside the keydown handler and re-pointed by "Load latest" (R6) -- a
  // plain mutable value tracked across renders, not a value that drives UI.
  const seededDraftRef = useRef('');

  // Read fresh inside the WebSocket callback below without forcing that
  // callback to be re-created (and re-subscribed) on every edit/view toggle
  // -- mirrors the ref-tracks-current-value pattern; assigning during render
  // keeps it correct without a useEffect.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Listen for real-time updates via WebSocket. This stays subscribed with a
  // stable identity (deps unchanged by entering/leaving edit mode); it reads
  // the current mode via modeRef rather than closing over the `mode` state
  // directly, per R6: an incoming update must still land in the query cache
  // even while a human is editing, but must never clobber their draft.
  const handleMemoUpdated = useCallback((sid: string, newContent: string) => {
    if (sid !== sessionId) {
      return;
    }
    queryClient.setQueryData(sessionKeys.memo(sessionId), newContent);
    if (modeRef.current === 'edit') {
      setHasIncomingUpdateWhileEditing(true);
    }
  }, [sessionId, queryClient]);

  useAppWsEvent({ onMemoUpdated: handleMemoUpdated });

  const { mutate: saveMemo, isPending: isSaving } = useMutation({
    mutationFn: (text: string) => updateSessionMemo(sessionId, text),
    onSuccess: (response) => {
      // Server is the source of truth -- write its response, not the
      // locally-typed draft, into the cache. No optimistic update before
      // this point.
      queryClient.setQueryData(sessionKeys.memo(sessionId), response.content);
      setMode('view');
      setHasIncomingUpdateWhileEditing(false);
      setSaveError(null);
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : 'Failed to save memo'),
  });

  // Render nothing while genuinely pending with no cached data yet (R1) --
  // once resolved (even to null), the panel stays mounted.
  if (isPending) {
    return null;
  }

  const isEmpty = content == null || content === '';

  function enterEditMode(seed: string) {
    setDraft(seed);
    seededDraftRef.current = seed;
    setHasIncomingUpdateWhileEditing(false);
    setSaveError(null);
    setMode('edit');
  }

  function handleCancel() {
    setMode('view');
    setHasIncomingUpdateWhileEditing(false);
    setSaveError(null);
  }

  function handleSave() {
    saveMemo(draft);
  }

  function handleLoadLatest() {
    const latest = queryClient.getQueryData<string | null>(sessionKeys.memo(sessionId)) ?? '';
    setDraft(latest);
    seededDraftRef.current = latest;
    setHasIncomingUpdateWhileEditing(false);
  }

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
      return;
    }
    if (e.key === 'Escape' && draft === seededDraftRef.current) {
      // Only cancel when nothing has changed since edit mode was entered (or
      // since "Load latest" last moved the baseline) -- a stray Escape must
      // never discard an in-progress edit.
      e.preventDefault();
      handleCancel();
    }
  }

  // R1b: with every section collapsed, this panel contributes only its
  // label button to the container's single narrow rail -- no border, no
  // strip of its own.
  if (compact) {
    return (
      <button
        onClick={onToggleExpanded}
        className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1"
        title="Expand memo"
        aria-label="Expand memo"
      >
        <span className="text-xs" style={{ writingMode: 'vertical-rl' }}>Memo</span>
      </button>
    );
  }

  // R1c: an accordion header row inside the container's single column,
  // separated from sibling sections horizontally (border-b), never by its
  // own border-l. The body stacks directly underneath the header when open.
  return (
    <div className="flex flex-col border-b border-slate-700">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-sm font-medium text-gray-300">Memo</span>
        <div className="flex items-center gap-1">
          {mode === 'view' && !isEmpty && (
            <button
              onClick={() => enterEditMode(content ?? '')}
              className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1 text-xs"
              title="Edit memo"
              aria-label="Edit memo"
            >
              Edit
            </button>
          )}
          <button
            onClick={onToggleExpanded}
            className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1 text-sm"
            title={isExpanded ? 'Collapse memo' : 'Expand memo'}
            aria-label={isExpanded ? 'Collapse memo' : 'Expand memo'}
          >
            {isExpanded ? '✕' : '▸'}
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="memo-content min-w-0 max-h-96 overflow-y-auto px-4 py-3 text-sm text-gray-300">
          {mode === 'edit' ? (
            <div className="flex flex-col gap-2">
              {hasIncomingUpdateWhileEditing && (
                <div className="flex items-center justify-between gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                  <span>Memo was updated while you were editing</span>
                  <button
                    type="button"
                    onClick={handleLoadLatest}
                    className="underline hover:text-amber-300 cursor-pointer bg-transparent border-none p-0"
                  >
                    Load latest
                  </button>
                </div>
              )}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleTextareaKeyDown}
                autoFocus
                aria-label="Memo content"
                className="w-full max-h-96 min-h-32 overflow-y-auto bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm text-gray-200 resize-y"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="btn text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed self-start"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isSaving}
                  className="text-xs text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                {saveError && <span className="text-xs text-red-400">{saveError}</span>}
              </div>
            </div>
          ) : isEmpty ? (
            <div className="flex flex-col items-start gap-2">
              <span className="text-sm text-gray-500">No memo yet.</span>
              <button
                type="button"
                onClick={() => enterEditMode('')}
                className="btn text-xs bg-blue-600 hover:bg-blue-500 self-start"
              >
                Write memo
              </button>
            </div>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          )}
        </div>
      )}
    </div>
  );
}
