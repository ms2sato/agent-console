import { useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSessionMemo } from '../../lib/api';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { sessionKeys } from '../../lib/query-keys';

interface MemoPanelProps {
  sessionId: string;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  compact: boolean;
}

export function MemoPanel({ sessionId, isExpanded, onToggleExpanded, compact }: MemoPanelProps) {
  const queryClient = useQueryClient();

  const { data: content, isPending } = useQuery({
    queryKey: sessionKeys.memo(sessionId),
    queryFn: () => fetchSessionMemo(sessionId),
  });

  // Listen for real-time updates via WebSocket
  useAppWsEvent({
    onMemoUpdated: useCallback((sid: string, newContent: string) => {
      if (sid === sessionId) {
        queryClient.setQueryData(sessionKeys.memo(sessionId), newContent);
      }
    }, [sessionId, queryClient]),
  });

  // Don't render anything if no memo exists or still loading.
  if (isPending || content == null) {
    return null;
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
        <button
          onClick={onToggleExpanded}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1 text-sm"
          title={isExpanded ? 'Collapse memo' : 'Expand memo'}
          aria-label={isExpanded ? 'Collapse memo' : 'Expand memo'}
        >
          {isExpanded ? '✕' : '▸'}
        </button>
      </div>
      {isExpanded && (
        <div className="memo-content min-w-0 max-h-96 overflow-y-auto px-4 py-3 text-sm text-gray-300">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      )}
    </div>
  );
}
