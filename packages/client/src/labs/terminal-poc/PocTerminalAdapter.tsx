import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { TerminalProps } from '../../components/Terminal';
import { WorkerErrorRecovery } from '../../components/WorkerErrorRecovery';
import { TerminalLoadingBar } from '../../components/ui/TerminalLoadingBar';
import { deleteSession } from '../../lib/api';
import { emitSessionDeleted } from '../../lib/app-websocket';
import { getOrCreatePocTerminal, type PocStatus, type PocTerminalInstance } from './poc-terminal-store';
import { PocTerminalView } from './PocTerminalView';
import { PocKeyboardInput } from './PocKeyboardInput';
import { toStatusChangeArgs } from './poc-status-mapping';
import { githubRefDecorator } from './transforms/github-refs';
import type { SegmentDecorator, TransformContext } from './row-transforms';
import { useSessionRepoFullName } from './useSessionRepoFullName';

// Constant decorator list — memoized identity so the memoized Row is stable.
const SEGMENT_DECORATORS: readonly SegmentDecorator[] = [githubRefDecorator];

/**
 * Drop-in replacement for `components/Terminal.tsx` implementing the exact
 * `TerminalProps` contract, so the eventual flag swap in `SessionPage.tsx` is a
 * one-import change. It composes the PoC store + view + keyboard input and
 * reuses the production `WorkerErrorRecovery` overlay and `TerminalLoadingBar`
 * as-is (renderer-agnostic).
 */
export function PocTerminalAdapter({
  sessionId,
  workerId,
  onStatusChange,
  onActivityChange,
  onRequestRestart,
  onResumeSession,
  onFilesReceived,
  hideStatusBar,
  stripScrollbackClear,
}: TerminalProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The instance is keyed by sessionId:workerId in the module store and outlives
  // React mounts. stripScrollbackClear is read once at creation (config is fixed
  // per instance lifetime); passing it here again on prop change is a harmless
  // no-op because getOrCreate returns the existing instance.
  //
  // When the prop is undefined, OMIT the option so the store default governs —
  // this keeps an adapter-first instance behaving identically to a labs-route-
  // first instance for the same worker (a `?? false` here would flip the store
  // default and diverge intra-labs). Production SessionPage always passes an
  // explicit boolean, so drop-in parity is unaffected.
  const instance = useMemo(
    () =>
      getOrCreatePocTerminal(
        sessionId,
        workerId,
        stripScrollbackClear === undefined ? undefined : { stripScrollbackClear },
      ),
    [sessionId, workerId, stripScrollbackClear],
  );

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  // Linkify GitHub refs (#958). repoFullName is null for quick sessions / repos
  // without a GitHub remote — bare refs then stay plain text.
  const repoFullName = useSessionRepoFullName(sessionId);
  const transformContext = useMemo<TransformContext>(() => ({ repoFullName }), [repoFullName]);

  // Mirror Terminal.tsx delete-session recovery: delete via API, then broadcast
  // session-deleted and return to the dashboard.
  const deleteSessionMutation = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      emitSessionDeleted(sessionId);
      navigate({ to: '/' });
    },
  });

  const handleRetry = useCallback(() => instance.retry(), [instance]);
  const handleDeleteSession = useCallback(() => deleteSessionMutation.mutate(), [deleteSessionMutation]);
  const handleGoToDashboard = useCallback(() => navigate({ to: '/' }), [navigate]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[#1a1a2e]">
      <StatusCallbackBridge
        instance={instance}
        onStatusChange={onStatusChange}
        onActivityChange={onActivityChange}
      />

      {!hideStatusBar && <AdapterStatusBar instance={instance} />}

      <AdapterNoticeBanner instance={instance} />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <AdapterLoadingBar instance={instance} />
        <PocTerminalView
          instance={instance}
          onRequestFocus={focusInput}
          onFilesReceived={onFilesReceived}
          inputRef={inputRef}
          segmentDecorators={SEGMENT_DECORATORS}
          transformContext={transformContext}
        />
        <AdapterRecoveryOverlay
          instance={instance}
          onRetry={handleRetry}
          onDeleteSession={handleDeleteSession}
          onGoToDashboard={handleGoToDashboard}
          onRestart={onRequestRestart}
          onResumeSession={onResumeSession}
        />
      </div>

      <PocKeyboardInput ref={inputRef} instance={instance} onFilesReceived={onFilesReceived} />

      <AdapterExitBanner instance={instance} />
    </div>
  );
}

/**
 * Subscribed, render-null bridge that forwards snapshot changes to the parent
 * callbacks. Isolated so the outer adapter does not re-render on every frame.
 */
function StatusCallbackBridge({
  instance,
  onStatusChange,
  onActivityChange,
}: {
  instance: PocTerminalInstance;
  onStatusChange: TerminalProps['onStatusChange'];
  onActivityChange: TerminalProps['onActivityChange'];
}) {
  const { status, exitInfo, activityState } = useSyncExternalStore(
    instance.subscribe,
    instance.getSnapshot,
  );

  useEffect(() => {
    const args = toStatusChangeArgs({ status, exitInfo });
    onStatusChange?.(args.status, args.exitInfo);
  }, [status, exitInfo, onStatusChange]);

  useEffect(() => {
    if (activityState) onActivityChange?.(activityState);
  }, [activityState, onActivityChange]);

  return null;
}

function AdapterStatusBar({ instance }: { instance: PocTerminalInstance }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  const color =
    snapshot.status === 'connected'
      ? 'bg-green-500'
      : snapshot.status === 'exited'
        ? 'bg-red-500'
        : snapshot.status === 'disconnected'
          ? 'bg-gray-500'
          : 'bg-yellow-500';
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-gray-700 bg-slate-900 px-3 py-2">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      <span className="text-sm text-gray-500">{statusText(snapshot.status, snapshot.exitInfo)}</span>
    </div>
  );
}

function statusText(
  status: PocStatus,
  exitInfo: { code: number; signal: string | null } | null,
): string {
  switch (status) {
    case 'connecting':
      return 'Connecting...';
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'exited':
      return `Exited (code: ${exitInfo?.code}${exitInfo?.signal ? `, signal: ${exitInfo.signal}` : ''})`;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function AdapterLoadingBar({ instance }: { instance: PocTerminalInstance }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  return <TerminalLoadingBar visible={snapshot.loadingHistory} />;
}

function AdapterNoticeBanner({ instance }: { instance: PocTerminalInstance }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (!snapshot.notice) return null;
  return (
    <div className="flex items-center justify-between gap-2 bg-amber-900/60 px-3 py-1 text-xs text-amber-200">
      <span>{snapshot.notice}</span>
      <button
        type="button"
        onClick={() => instance.dismissNotice()}
        className="rounded bg-amber-700/60 px-2 py-0.5 hover:bg-amber-600/60"
      >
        Dismiss
      </button>
    </div>
  );
}

function AdapterExitBanner({ instance }: { instance: PocTerminalInstance }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (snapshot.status !== 'exited' || !snapshot.exitInfo) return null;
  return (
    <div className="bg-red-900/60 px-3 py-1 text-center text-xs text-red-200">
      Process exited (code {snapshot.exitInfo.code}
      {snapshot.exitInfo.signal ? `, signal ${snapshot.exitInfo.signal}` : ''})
    </div>
  );
}

function AdapterRecoveryOverlay({
  instance,
  onRetry,
  onDeleteSession,
  onGoToDashboard,
  onRestart,
  onResumeSession,
}: {
  instance: PocTerminalInstance;
  onRetry: () => void;
  onDeleteSession: () => void;
  onGoToDashboard: () => void;
  onRestart: TerminalProps['onRequestRestart'];
  onResumeSession: TerminalProps['onResumeSession'];
}) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (!snapshot.workerError) return null;
  return (
    <WorkerErrorRecovery
      errorCode={snapshot.workerError.code}
      errorMessage={snapshot.workerError.message}
      onRetry={onRetry}
      onDeleteSession={onDeleteSession}
      onGoToDashboard={onGoToDashboard}
      onRestart={onRestart}
      onResumeSession={onResumeSession}
    />
  );
}
