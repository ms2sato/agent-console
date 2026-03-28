import { useState, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSessionMemo } from '../../lib/api';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { sessionKeys } from '../../lib/query-keys';

interface MemoPanelProps {
  sessionId: string;
}

export function MemoPanel({ sessionId }: MemoPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
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

  // Don't render anything if no memo exists or still loading
  if (isPending || content == null) {
    return null;
  }

  // Collapsed state - show thin strip with toggle button
  if (!isExpanded) {
    return (
      <div className="hidden md:flex flex-col items-center border-l border-slate-700 bg-slate-800 py-2 px-1">
        <button
          onClick={() => setIsExpanded(true)}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1"
          title="Expand memo"
          aria-label="Expand memo"
        >
          <span className="text-xs" style={{ writingMode: 'vertical-rl' }}>Memo</span>
        </button>
      </div>
    );
  }

  // Expanded sidebar
  return (
    <div className="hidden md:flex flex-col w-80 border-l border-slate-700 bg-slate-800 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700">
        <span className="text-sm font-medium text-gray-300">Memo</span>
        <button
          onClick={() => setIsExpanded(false)}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1 text-sm"
          title="Collapse memo"
          aria-label="Collapse memo"
        >
          ✕
        </button>
      </div>
      {/* Content */}
      <div className="memo-content min-w-0 flex-1 overflow-y-auto px-4 py-3 text-sm text-gray-300">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </div>
  );
}
