import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import { fetchSessionMemo } from '../../lib/api';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { logger } from '../../lib/logger';

interface MemoPanelProps {
  sessionId: string;
}

export function MemoPanel({ sessionId }: MemoPanelProps) {
  const [content, setContent] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch memo on mount
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchSessionMemo(sessionId)
      .then((memo) => {
        if (!cancelled) {
          setContent(memo);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          logger.error('Failed to fetch memo:', err);
          setIsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Listen for real-time updates via WebSocket
  useAppWsEvent({
    onMemoUpdated: useCallback((sid: string, newContent: string) => {
      if (sid === sessionId) {
        setContent(newContent);
      }
    }, [sessionId]),
  });

  // Don't render anything if no memo exists or still loading
  if (isLoading || content === null) {
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
      <div className="memo-content flex-1 overflow-y-auto px-4 py-3 text-sm text-gray-300">
        <Markdown>{content}</Markdown>
      </div>
    </div>
  );
}
