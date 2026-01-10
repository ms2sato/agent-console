import { useState, useCallback, useEffect, useRef } from 'react';
import type { GitDiffTarget } from '@agent-console/shared';
import { useGitDiffWorker } from '../../hooks/useGitDiffWorker';
import { useDiffScrollPosition, getStoredVisibleFile } from '../../hooks/useDiffScrollPosition';
import { RefreshIcon } from '../Icons';
import { DiffViewer } from './DiffViewer';
import { DiffFileList } from './DiffFileList';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { BaseCommitSelector } from './BaseCommitSelector';
import { TargetRefSelector } from './TargetRefSelector';

// Track which session/worker combos have had their scroll restored in this page session.
// Persists across component remounts but resets on page reload.
const scrollRestoredSet = new Set<string>();

// Timing constants for scroll restoration
const SCROLL_RESTORE_DELAY_MS = 100; // Wait for DOM to render before scrolling
const SCROLL_CLEAR_DELAY_MS = 1000; // Keep scrollToFile active for rAF retry loop

interface GitDiffWorkerViewProps {
  sessionId: string;
  workerId: string;
}

export function GitDiffWorkerView({ sessionId, workerId }: GitDiffWorkerViewProps) {
  const { diffData, error, loading, connected, refresh, setBaseCommit, setTargetCommit } = useGitDiffWorker({
    sessionId,
    workerId,
  });

  // Track scroll position with localStorage persistence
  const {
    visibleFile,
    initialScrollTarget,
    setVisibleFile,
    saveScrollPosition,
    clearInitialScrollTarget,
    refreshInitialScrollTarget,
  } = useDiffScrollPosition(sessionId, workerId);

  // Track file to scroll to (set when clicking sidebar or restoring position)
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);
  // Key for tracking scroll restoration across remounts
  const scrollKey = `${sessionId}:${workerId}`;
  // Use ref to prevent duplicate scroll attempts within the same mount
  const scrollAttemptedRef = useRef(false);
  // Track whether scroll restoration is complete (to prevent IntersectionObserver from overwriting)
  const scrollRestorationCompleteRef = useRef(false);

  // Handle file click in sidebar - triggers scroll and saves position
  const handleFileClick = useCallback(
    (filePath: string) => {
      scrollRestorationCompleteRef.current = true;
      setScrollToFile(filePath);
      saveScrollPosition(filePath);
      setTimeout(() => setScrollToFile(null), SCROLL_CLEAR_DELAY_MS);
    },
    [saveScrollPosition]
  );

  // Handle file becoming visible in diff viewer.
  // Only updates UI highlighting, does NOT save to localStorage.
  // Skip updates until scroll restoration is complete to prevent overwriting saved position.
  const handleFileVisible = useCallback(
    (filePath: string) => {
      if (scrollRestorationCompleteRef.current) {
        setVisibleFile(filePath);
      }
    },
    [setVisibleFile]
  );

  // Reset scroll restoration state on mount/unmount.
  // Refresh from localStorage on mount to handle HMR state preservation.
  // We do NOT save scroll position on unmount because IntersectionObserver
  // may report the wrong file during scroll animations.
  useEffect(() => {
    refreshInitialScrollTarget();
    return () => {
      scrollRestoredSet.delete(scrollKey);
      scrollAttemptedRef.current = false;
      scrollRestorationCompleteRef.current = false;
    };
  }, [scrollKey, refreshInitialScrollTarget]);

  // Restore scroll position on initial load when diff data is ready
  useEffect(() => {
    // Skip if already restored in this page session or mount
    if (scrollRestoredSet.has(scrollKey) || scrollAttemptedRef.current) {
      return;
    }

    // Get scroll target - prefer state, fallback to localStorage for timing issues
    // (state update from refreshInitialScrollTarget may not have completed yet)
    const scrollTarget = initialScrollTarget ?? getStoredVisibleFile(sessionId, workerId);

    // If no scroll target, enable IntersectionObserver tracking immediately
    if (!scrollTarget) {
      scrollRestorationCompleteRef.current = true;
      return;
    }

    // Wait for diff data to be ready
    const files = diffData?.summary?.files;
    if (!files || files.length === 0) {
      return;
    }

    scrollAttemptedRef.current = true;

    const fileExists = files.some((file) => file.path === scrollTarget);
    if (fileExists) {
      setTimeout(() => {
        setScrollToFile(scrollTarget);
        setVisibleFile(scrollTarget);
        scrollRestoredSet.add(scrollKey);
        scrollRestorationCompleteRef.current = true;
        setTimeout(() => setScrollToFile(null), SCROLL_CLEAR_DELAY_MS);
      }, SCROLL_RESTORE_DELAY_MS);
    } else {
      scrollRestoredSet.add(scrollKey);
      scrollRestorationCompleteRef.current = true;
    }

    clearInitialScrollTarget();
  }, [scrollKey, initialScrollTarget, diffData, clearInitialScrollTarget, sessionId, workerId, setVisibleFile]);

  // Handle initial loading state (no data yet)
  // Note: When refreshing with existing data, we keep showing the old content
  // to preserve scroll position in DiffViewer
  if (loading && !diffData) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
        <Header
          sessionId={sessionId}
          baseCommit={null}
          targetRef="working-dir"
          totalAdditions={0}
          totalDeletions={0}
          filesChanged={0}
          onRefresh={refresh}
          onBaseCommitChange={setBaseCommit}
          onTargetRefChange={setTargetCommit}
          loading={true}
          currentBaseCommit={null}
        />
        <div className="flex items-center justify-center flex-1 text-gray-500">
          Loading diff data...
        </div>
      </div>
    );
  }

  // Handle error state
  if (error) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
        <Header
          sessionId={sessionId}
          baseCommit={null}
          targetRef="working-dir"
          totalAdditions={0}
          totalDeletions={0}
          filesChanged={0}
          onRefresh={refresh}
          onBaseCommitChange={setBaseCommit}
          onTargetRefChange={setTargetCommit}
          loading={false}
          currentBaseCommit={null}
        />
        <div className="flex flex-col items-center justify-center flex-1 text-red-400">
          <p className="text-lg font-medium">Error Loading Diff</p>
          <p className="text-sm text-gray-500 mt-2">{error}</p>
          <button
            onClick={refresh}
            className="btn btn-primary text-sm mt-4"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Handle empty state (no diff data)
  if (!diffData || !diffData.summary) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
        <Header
          sessionId={sessionId}
          baseCommit={null}
          targetRef="working-dir"
          totalAdditions={0}
          totalDeletions={0}
          filesChanged={0}
          onRefresh={refresh}
          onBaseCommitChange={setBaseCommit}
          onTargetRefChange={setTargetCommit}
          loading={false}
          currentBaseCommit={null}
        />
        <div className="flex items-center justify-center flex-1 text-gray-500">
          No diff data available
        </div>
      </div>
    );
  }

  const { summary, rawDiff } = diffData;
  const { baseCommit, targetRef, files, totalAdditions, totalDeletions } = summary;

  // Handle no changes state
  if (files.length === 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
        <Header
          sessionId={sessionId}
          baseCommit={baseCommit}
          targetRef={targetRef}
          totalAdditions={totalAdditions}
          totalDeletions={totalDeletions}
          filesChanged={files.length}
          onRefresh={refresh}
          onBaseCommitChange={setBaseCommit}
          onTargetRefChange={setTargetCommit}
          loading={false}
          currentBaseCommit={baseCommit}
        />
        <div className="flex items-center justify-center flex-1 text-gray-500">
          No changes to display
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
      {/* Header */}
      <Header
        sessionId={sessionId}
        baseCommit={baseCommit}
        targetRef={targetRef}
        totalAdditions={totalAdditions}
        totalDeletions={totalDeletions}
        filesChanged={files.length}
        onRefresh={refresh}
        onBaseCommitChange={setBaseCommit}
        onTargetRefChange={setTargetCommit}
        loading={loading}
        currentBaseCommit={baseCommit}
      />

      {/* Split pane layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: File list */}
        <div className="w-80 shrink-0 border-r border-gray-700 overflow-hidden">
          <DiffFileList
            files={files}
            selectedPath={visibleFile}
            onSelectFile={handleFileClick}
          />
        </div>

        {/* Right: Diff viewer - shows all files stacked */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <ErrorBoundary
            fallback={(error, resetError) => (
              <div className="flex flex-col items-center justify-center h-full p-8 text-center bg-slate-900">
                <div className="text-red-400 text-lg font-medium mb-2">Failed to parse diff</div>
                <div className="text-gray-500 text-sm mb-4 max-w-md font-mono bg-slate-800 p-3 rounded">
                  {error.message}
                </div>
                <div className="flex gap-3">
                  <button onClick={resetError} className="btn btn-primary text-sm">
                    Retry
                  </button>
                  <button onClick={refresh} className="btn bg-slate-600 hover:bg-slate-500 text-sm">
                    Refresh Diff
                  </button>
                </div>
              </div>
            )}
          >
            <DiffViewer
              rawDiff={rawDiff}
              files={files}
              scrollToFile={scrollToFile}
              onFileVisible={handleFileVisible}
            />
          </ErrorBoundary>
        </div>
      </div>

      {/* Connection status indicator */}
      {!connected && (
        <div className="absolute top-2 right-2 px-3 py-1 bg-red-900/80 text-red-200 text-xs rounded">
          Disconnected
        </div>
      )}
    </div>
  );
}

interface HeaderProps {
  sessionId: string;
  baseCommit: string | null;
  targetRef: GitDiffTarget;
  totalAdditions: number;
  totalDeletions: number;
  filesChanged: number;
  onRefresh: () => void;
  onBaseCommitChange: (ref: string) => void;
  onTargetRefChange: (ref: GitDiffTarget) => void;
  loading: boolean;
  currentBaseCommit: string | null;
}

function Header({
  sessionId,
  baseCommit,
  targetRef,
  totalAdditions,
  totalDeletions,
  filesChanged,
  onRefresh,
  onBaseCommitChange,
  onTargetRefChange,
  loading,
  currentBaseCommit,
}: HeaderProps) {
  return (
    <div className="px-4 py-3 bg-slate-800 border-b border-gray-700 shrink-0">
      <div className="flex items-center justify-between">
        {/* Title and comparison info */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Comparing:</span>
          <BaseCommitSelector
            sessionId={sessionId}
            currentBaseCommit={baseCommit}
            onBaseCommitChange={onBaseCommitChange}
            disabled={loading}
          />
          <span className="text-gray-500">...</span>
          <TargetRefSelector
            sessionId={sessionId}
            currentTargetRef={targetRef}
            currentBaseCommit={currentBaseCommit}
            onTargetRefChange={onTargetRefChange}
            disabled={loading}
          />
        </div>

        {/* Stats and refresh button */}
        <div className="flex items-center gap-4">
          {/* Stats */}
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-400">
              {filesChanged} {filesChanged === 1 ? 'file' : 'files'}
            </span>
            <span className="text-green-400">
              +{totalAdditions}
            </span>
            <span className="text-red-400">
              -{totalDeletions}
            </span>
          </div>

          {/* Refresh button */}
          <button
            onClick={onRefresh}
            disabled={loading}
            className="btn btn-primary text-sm flex items-center gap-2"
            title="Refresh diff"
          >
            <RefreshIcon className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
