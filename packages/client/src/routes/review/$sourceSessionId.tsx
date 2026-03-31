import { useState, useCallback, useEffect, useRef } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReviewQueueItem } from '@agent-console/shared';
import { fetchReviewQueue, addReviewComment, updateReviewStatus } from '../../lib/api';
import { reviewQueueKeys } from '../../lib/query-keys';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { useGitDiffWorker } from '../../components/workers/hooks/useGitDiffWorker';
import { DiffViewer } from '../../components/workers/DiffViewer';
import { DiffFileList } from '../../components/workers/DiffFileList';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { Spinner } from '../../components/ui/Spinner';

export const Route = createFileRoute('/review/$sourceSessionId')({
  component: ReviewDiffPage,
  head: () => ({
    meta: [{ title: 'Review' }],
  }),
});

function ReviewDiffPage() {
  const { sourceSessionId } = Route.useParams();
  const queryClient = useQueryClient();

  // Current index in the items list
  const [currentIndex, setCurrentIndex] = useState(0);
  // Toggle full diff vs annotated only
  const [showFullDiff, setShowFullDiff] = useState(false);
  // Inline comment state
  const [commentState, setCommentState] = useState<{ file: string; line: number } | null>(null);
  const [commentBody, setCommentBody] = useState('');
  // Track visible file for sidebar highlighting
  const [visibleFile, setVisibleFile] = useState<string | null>(null);
  // Track file to scroll to
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch review queue and filter to this source session
  const { data: groups, isLoading: isLoadingQueue } = useQuery({
    queryKey: reviewQueueKeys.list(),
    queryFn: fetchReviewQueue,
  });

  // Real-time updates
  useAppWsEvent({
    onReviewQueueUpdated: () => {
      queryClient.invalidateQueries({ queryKey: reviewQueueKeys.root() });
    },
  });

  // Find items for this source session
  const group = groups?.find((g) => g.sourceSessionId === sourceSessionId);
  const items: ReviewQueueItem[] = group?.items ?? [];
  const currentItem = items[currentIndex] ?? null;

  // Clamp index when items change (must not call setState during render)
  useEffect(() => {
    if (items.length === 0) return;
    const safeIndex = Math.min(currentIndex, items.length - 1);
    if (safeIndex !== currentIndex) {
      setCurrentIndex(safeIndex);
    }
  }, [items.length, currentIndex]);

  // Navigation
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < items.length - 1;
  const goPrev = useCallback(() => {
    if (hasPrev) setCurrentIndex((i) => i - 1);
  }, [hasPrev]);
  const goNext = useCallback(() => {
    if (hasNext) setCurrentIndex((i) => i + 1);
  }, [hasNext]);

  // Mark as completed mutation
  const completeMutation = useMutation({
    mutationFn: (workerId: string) => updateReviewStatus(workerId, 'completed'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reviewQueueKeys.root() });
    },
  });

  // Add comment mutation
  const commentMutation = useMutation({
    mutationFn: (params: { workerId: string; file: string; line: number; body: string }) =>
      addReviewComment(params.workerId, { file: params.file, line: params.line, body: params.body }),
    onSuccess: () => {
      setCommentState(null);
      setCommentBody('');
      queryClient.invalidateQueries({ queryKey: reviewQueueKeys.root() });
    },
  });

  const handleSubmitComment = useCallback(() => {
    if (!currentItem || !commentState || !commentBody.trim()) return;
    commentMutation.mutate({
      workerId: currentItem.workerId,
      file: commentState.file,
      line: commentState.line,
      body: commentBody.trim(),
    });
  }, [currentItem, commentState, commentBody, commentMutation]);

  const handleCancelComment = useCallback(() => {
    setCommentState(null);
    setCommentBody('');
  }, []);

  const handleMarkComplete = useCallback(() => {
    if (!currentItem) return;
    completeMutation.mutate(currentItem.workerId, {
      onSuccess: () => {
        // Auto-advance to next after successful completion
        if (hasNext) {
          setCurrentIndex((i) => i + 1);
        }
      },
    });
  }, [currentItem, completeMutation, hasNext]);

  const handleFileClick = useCallback((filePath: string) => {
    setScrollToFile(filePath);
    setVisibleFile(filePath);
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => setScrollToFile(null), 1000);
  }, []);

  // Cleanup scroll timer on unmount
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const handleFileVisible = useCallback((filePath: string) => {
    setVisibleFile(filePath);
  }, []);

  // Loading state
  if (isLoadingQueue) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading review items...</span>
        </div>
      </div>
    );
  }

  // Group not found or empty
  if (!group || items.length === 0) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <PageBreadcrumb items={[
          { label: 'Agent Console', to: '/' },
          { label: 'Review Queue', to: '/review' },
          { label: 'Session' },
        ]} />
        <div className="card text-center py-16">
          <p className="text-gray-400 text-lg mb-2">All reviews completed</p>
          <p className="text-gray-500 text-sm mb-4">No pending review items for this session.</p>
          <Link to="/review" className="btn btn-primary text-sm">
            Back to Queue
          </Link>
        </div>
      </div>
    );
  }

  const completedCount = items.filter((i) => i.status === 'completed').length;

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-900">
      {/* Top bar: breadcrumb + navigation + progress */}
      <div className="px-4 py-2 bg-slate-800 border-b border-gray-700 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              to="/review"
              className="text-sm text-slate-400 hover:text-white no-underline shrink-0"
            >
              Review Queue
            </Link>
            <span className="text-slate-600">/</span>
            <span className="text-sm text-white truncate">
              {group.sourceSessionTitle || 'Untitled Session'}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Progress */}
            <span className="text-sm text-gray-400">
              {currentIndex + 1} / {items.length}
              {completedCount > 0 && (
                <span className="text-green-400 ml-2">
                  ({completedCount} reviewed)
                </span>
              )}
            </span>

            {/* Navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={goPrev}
                disabled={!hasPrev}
                className="btn text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1"
                title="Previous"
              >
                Prev
              </button>
              <button
                onClick={goNext}
                disabled={!hasNext}
                className="btn text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1"
                title="Next"
              >
                Next
              </button>
            </div>

            {/* Mark complete */}
            {currentItem && currentItem.status === 'pending' && (
              <button
                onClick={handleMarkComplete}
                disabled={completeMutation.isPending}
                className="btn text-xs bg-green-700 hover:bg-green-600"
              >
                {completeMutation.isPending ? 'Completing...' : 'Mark Reviewed'}
              </button>
            )}
            {currentItem && currentItem.status === 'completed' && (
              <span className="text-xs text-green-400 px-2 py-1 bg-green-900/30 rounded">
                Reviewed
              </span>
            )}
          </div>
        </div>

        {/* Item info bar */}
        {currentItem && (
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
            <span>Session: {currentItem.sessionTitle || currentItem.sessionId.slice(0, 8)}</span>
            <span>{currentItem.annotationCount} annotations</span>
            {currentItem.commentCount > 0 && (
              <span>{currentItem.commentCount} comments</span>
            )}
          </div>
        )}
      </div>

      {/* Annotation filter toggle */}
      {currentItem && (
        <div className="px-4 py-1.5 bg-amber-900/20 border-b border-amber-700/30 shrink-0 flex items-center justify-between">
          <span className="text-xs text-amber-300/70">
            {currentItem.annotationCount} sections need attention
          </span>
          <button
            onClick={() => setShowFullDiff((prev) => !prev)}
            className="text-xs px-2 py-0.5 rounded bg-amber-800/40 hover:bg-amber-700/40 text-amber-200 transition-colors"
          >
            {showFullDiff ? 'Show annotated only' : 'Show full diff'}
          </button>
        </div>
      )}

      {/* Diff content */}
      {currentItem ? (
        <ReviewDiffContent
          key={currentItem.workerId}
          item={currentItem}
          showFullDiff={showFullDiff}
          scrollToFile={scrollToFile}
          visibleFile={visibleFile}
          onFileClick={handleFileClick}
          onFileVisible={handleFileVisible}
          commentState={commentState}
          commentBody={commentBody}
          commentMutation={commentMutation}
          onCommentBodyChange={setCommentBody}
          onSubmitComment={handleSubmitComment}
          onCancelComment={handleCancelComment}
        />
      ) : (
        <div className="flex items-center justify-center flex-1 text-gray-500">
          No item selected
        </div>
      )}
    </div>
  );
}

interface ReviewDiffContentProps {
  item: ReviewQueueItem;
  showFullDiff: boolean;
  scrollToFile: string | null;
  visibleFile: string | null;
  onFileClick: (filePath: string) => void;
  onFileVisible: (filePath: string) => void;
  commentState: { file: string; line: number } | null;
  commentBody: string;
  commentMutation: { isPending: boolean };
  onCommentBodyChange: (body: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
}

function ReviewDiffContent({
  item,
  showFullDiff,
  scrollToFile,
  visibleFile,
  onFileClick,
  onFileVisible,
  commentState,
  commentBody,
  commentMutation,
  onCommentBodyChange,
  onSubmitComment,
  onCancelComment,
}: ReviewDiffContentProps) {
  const {
    diffData,
    error,
    loading,
    connected,
    refresh,
    expandedLines,
    requestFileLines,
    annotationSet,
  } = useGitDiffWorker({
    sessionId: item.sessionId,
    workerId: item.workerId,
  });

  // Loading state
  if (loading && !diffData) {
    return (
      <div className="flex items-center justify-center flex-1 text-gray-500">
        <Spinner size="sm" />
        <span className="ml-2">Loading diff data...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 text-red-400">
        <p className="text-lg font-medium">Error Loading Diff</p>
        <p className="text-sm text-gray-500 mt-2">{error}</p>
        <button onClick={refresh} className="btn btn-primary text-sm mt-4">
          Retry
        </button>
      </div>
    );
  }

  // No data
  if (!diffData || !diffData.summary || diffData.summary.files.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 text-gray-500">
        No changes to display
      </div>
    );
  }

  const { files } = diffData.summary;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden relative">
      {/* Left: File list */}
      <div className="w-80 shrink-0 border-r border-gray-700 overflow-hidden">
        <DiffFileList
          files={files}
          selectedPath={visibleFile}
          onSelectFile={onFileClick}
          annotationSet={annotationSet}
          showFullDiff={showFullDiff}
        />
      </div>

      {/* Right: Diff viewer */}
      <div className="flex-1 min-w-0 overflow-hidden relative">
        <ErrorBoundary
          fallback={(err, resetError) => (
            <div className="flex flex-col items-center justify-center h-full p-8 text-center bg-slate-900">
              <div className="text-red-400 text-lg font-medium mb-2">Failed to parse diff</div>
              <div className="text-gray-500 text-sm mb-4 max-w-md font-mono bg-slate-800 p-3 rounded">
                {err.message}
              </div>
              <div className="flex gap-3">
                <button onClick={resetError} className="btn btn-primary text-sm">Retry</button>
                <button onClick={refresh} className="btn bg-slate-600 hover:bg-slate-500 text-sm">
                  Refresh Diff
                </button>
              </div>
            </div>
          )}
        >
          <DiffViewer
            rawDiff={diffData.rawDiff}
            files={files}
            scrollToFile={scrollToFile}
            onFileVisible={onFileVisible}
            expandedLines={expandedLines}
            onRequestExpand={requestFileLines}
            annotationSet={annotationSet}
            showFullDiff={showFullDiff}
          />
        </ErrorBoundary>

        {/* Inline comment input overlay */}
        {commentState && (
          <div className="absolute bottom-0 left-0 right-0 bg-slate-800 border-t border-gray-600 p-3">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-400 mb-1">
                  Comment on {commentState.file}:{commentState.line}
                </div>
                <textarea
                  value={commentBody}
                  onChange={(e) => onCommentBodyChange(e.target.value)}
                  placeholder="Write your comment..."
                  className="w-full bg-slate-900 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                  rows={2}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      onSubmitComment();
                    }
                    if (e.key === 'Escape') {
                      onCancelComment();
                    }
                  }}
                />
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <button
                  onClick={onSubmitComment}
                  disabled={!commentBody.trim() || commentMutation.isPending}
                  className="btn text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
                >
                  {commentMutation.isPending ? 'Sending...' : 'Send'}
                </button>
                <button
                  onClick={onCancelComment}
                  className="btn text-xs bg-slate-700 hover:bg-slate-600"
                >
                  Cancel
                </button>
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Ctrl+Enter to send, Escape to cancel
            </div>
          </div>
        )}
      </div>

      {/* Connection status */}
      {!connected && (
        <div className="absolute top-2 right-2 px-3 py-1 bg-red-900/80 text-red-200 text-xs rounded">
          Disconnected
        </div>
      )}
    </div>
  );
}
