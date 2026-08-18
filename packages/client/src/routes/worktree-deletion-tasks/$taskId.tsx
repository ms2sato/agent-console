import { useEffect, useRef } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { JOB_STATUS } from '@agent-console/shared';
import type { WorktreeDeletionStatus, HookCommandResult, Job } from '@agent-console/shared';
import { AlertCircleIcon, CheckIcon } from '../../components/Icons';
import { Spinner } from '../../components/ui/Spinner';
import { PagePendingFallback } from '../../components/PagePendingFallback';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { useWorktreeDeletionTasksContext } from '../__root';
import { useAppWsState } from '../../hooks/useAppWs';
import { deleteWorktreeAsync, fetchJob, ApiError } from '../../lib/api';
import { jobKeys } from '../../lib/query-keys';
import { logger } from '../../lib/logger';

export const Route = createFileRoute('/worktree-deletion-tasks/$taskId')({
  component: WorktreeDeletionTaskPage,
});

/**
 * Render-able subset of a worktree deletion task's state, sourced either
 * from the live in-memory `WorktreeDeletionTasksContext` (the fast path --
 * populated when this tab witnessed the deletion start) or derived from a
 * `GET /api/jobs/:id` read (the recovery path -- used when the in-memory
 * task is absent, e.g. after a reload, in another tab, or when the
 * completion broadcast was missed).
 *
 * Structured result extras (`cleanupCommandResult`, `killErrors`,
 * `gitStatus`) are broadcast-only and are not recoverable from the job
 * record (an accepted cut, documented in the PR description) -- the
 * derived path only ever sets `error`.
 */
interface DeletionTaskView {
  status: WorktreeDeletionStatus;
  sessionTitle: string;
  error?: string;
  gitStatus?: string;
  cleanupCommandResult?: HookCommandResult;
  killErrors?: Array<{ sessionId: string; error: string }>;
  createdAt: string;
}

/** Context needed to act on a task (force delete / dismiss) regardless of source. */
interface DeletionTaskActionContext {
  repositoryId: string;
  worktreePath: string;
  sessionId: string;
  sessionTitle: string;
}

/**
 * Derive a render-able view + action context from a fetched `Job` row.
 * Returns `null` when the payload cannot be narrowed as a worktree-delete
 * payload (a `JobPayloadParseError`, or an unexpected shape) -- callers
 * treat that the same as "no usable record".
 */
function deriveFromJob(job: Job): { view: DeletionTaskView; action: Omit<DeletionTaskActionContext, 'sessionId'> } | null {
  const payload = job.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('repoId' in payload) ||
    !('worktreePath' in payload) ||
    typeof payload.repoId !== 'string' ||
    typeof payload.worktreePath !== 'string'
  ) {
    return null;
  }

  const { repoId: repositoryId, worktreePath } = payload;
  const status: WorktreeDeletionStatus =
    job.status === JOB_STATUS.COMPLETED
      ? 'completed'
      : job.status === JOB_STATUS.STALLED
        ? 'failed'
        : 'deleting';
  const sessionTitle = worktreePath.split('/').filter(Boolean).pop() || worktreePath;

  return {
    view: {
      status,
      sessionTitle,
      error: job.lastError ?? undefined,
      createdAt: new Date(job.createdAt).toISOString(),
    },
    action: { repositoryId, worktreePath, sessionTitle },
  };
}

function WorktreeDeletionTaskPage() {
  const { taskId } = Route.useParams();
  return <WorktreeDeletionTaskPageContent taskId={taskId} />;
}

/**
 * @internal Exported for testing -- lets tests render the page's actual
 * data-fetch + derivation logic with an explicit taskId, without needing to
 * drive a matching TanStack Router route tree just to reach `Route.useParams()`.
 */
export function WorktreeDeletionTaskPageContent({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { getTask, removeTask: removeTaskFromContext, addTask } = useWorktreeDeletionTasksContext();
  const { errorDialogProps, showError } = useErrorDialog();

  const liveTask = getTask(taskId);

  // Recovery path: only fetch when there is no live in-memory task. The
  // in-memory context (populated by this tab witnessing the deletion, or by
  // a live WebSocket broadcast) is always preferred when present.
  //
  // Poll while the recovered job is still non-terminal: a plain missed
  // broadcast (not a reconnect -- the WS can stay connected the whole time)
  // would otherwise leave this page showing "deleting" forever, since a
  // one-shot fetch has no other way to observe the job reaching a terminal
  // status. Polling only ever applies to the recovery path (`enabled`
  // already gates the fetch itself on `!liveTask`) -- a live in-memory task
  // doesn't need it, since the broadcast IS the live push for that path.
  const jobQuery = useQuery({
    queryKey: jobKeys.detail(taskId),
    queryFn: () => fetchJob(taskId),
    enabled: !liveTask,
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === JOB_STATUS.COMPLETED || status === JOB_STATUS.STALLED) return false;
      // Genuine "no record" (404) is permanent for this id -- a job row is
      // always created before the 202 response the client received, so a
      // 404 here can never later become a real record. Stop polling.
      // Transient errors (network failure, 500, etc.) keep polling so the
      // page recovers once the network/server comes back.
      const error = query.state.error;
      if (error instanceof ApiError && error.status === 404) return false;
      return 5000;
    },
  });

  // Re-derive the recovery-path read after an app-WS reconnect, in case the
  // stale response was fetched while the job was still in flight. Skips the
  // initial mount value: `everDisconnectedRef` only flips on an observed
  // `connected -> false` transition, so the first render (whatever its
  // initial `connected` value) never triggers an invalidate on its own.
  const connected = useAppWsState((s) => s.connected);
  const everDisconnectedRef = useRef(false);
  useEffect(() => {
    if (!liveTask) {
      if (!connected) {
        everDisconnectedRef.current = true;
      } else if (everDisconnectedRef.current) {
        everDisconnectedRef.current = false;
        queryClient.invalidateQueries({ queryKey: jobKeys.detail(taskId) });
      }
    }
  }, [connected, liveTask, queryClient, taskId]);

  let view: DeletionTaskView | undefined;
  let action: DeletionTaskActionContext | undefined;

  if (liveTask) {
    view = {
      status: liveTask.status,
      sessionTitle: liveTask.sessionTitle,
      error: liveTask.error,
      gitStatus: liveTask.gitStatus,
      cleanupCommandResult: liveTask.cleanupCommandResult,
      killErrors: liveTask.killErrors,
      createdAt: liveTask.createdAt,
    };
    action = {
      repositoryId: liveTask.repositoryId,
      worktreePath: liveTask.worktreePath,
      sessionId: liveTask.sessionId,
      sessionTitle: liveTask.sessionTitle,
    };
  } else if (jobQuery.data) {
    const derived = deriveFromJob(jobQuery.data);
    if (derived) {
      view = derived.view;
      action = { ...derived.action, sessionId: `no-session-${taskId}` };
    }
  }

  const forceDelete = async () => {
    if (!action) return;
    try {
      const { jobId } = await deleteWorktreeAsync(action.repositoryId, action.worktreePath, true);
      removeTaskFromContext(taskId);
      addTask({
        id: jobId,
        sessionId: action.sessionId,
        sessionTitle: action.sessionTitle,
        repositoryId: action.repositoryId,
        worktreePath: action.worktreePath,
      });
      navigate({ to: '/worktree-deletion-tasks/$taskId', params: { taskId: jobId } });
    } catch (err) {
      // Stay on the current page -- the old task record is still valid and
      // no new one was created, so there's nothing to navigate to.
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Failed to force delete worktree:', err);
      showError('Failed to Force Delete', message);
    }
  };

  const removeTask = () => {
    removeTaskFromContext(taskId);
    navigate({ to: '/' });
  };

  // Live task present, or a usable job-derived view: render the task detail.
  if (view && action) {
    return (
      <TaskDetail
        view={view}
        onForceDelete={forceDelete}
        onDismiss={removeTask}
        errorDialogProps={errorDialogProps}
      />
    );
  }

  // No live task, and the recovery fetch is still in flight.
  if (!liveTask && jobQuery.isPending) {
    return <PagePendingFallback message="Checking task status..." />;
  }

  // No live task, and the recovery fetch failed with a genuine "no record"
  // (404) or resolved to a job whose payload could not be parsed as a
  // worktree-delete payload. Honest copy only -- never imply completion,
  // since the client cannot know that from an absent record.
  const is404 = jobQuery.error instanceof ApiError && jobQuery.error.status === 404;
  const isGenericError = jobQuery.isError && !is404;

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="card text-center max-w-md">
        <h2 className="text-xl font-semibold mb-4">
          {isGenericError ? 'Unable to Check Task Status' : 'No Record of This Task'}
        </h2>
        <p className="text-gray-400 mb-6">
          {isGenericError
            ? 'Something went wrong while checking this task. Try reloading the page.'
            : 'No record of this task. It may be an old or invalid link.'}
        </p>
        <Link to="/" className="btn btn-primary no-underline">
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}

interface TaskDetailProps {
  view: DeletionTaskView;
  onForceDelete: () => void;
  onDismiss: () => void;
  errorDialogProps: ReturnType<typeof useErrorDialog>['errorDialogProps'];
}

function TaskDetail({ view: task, onForceDelete, onDismiss, errorDialogProps }: TaskDetailProps) {
  const isFailed = task.status === 'failed';
  const isDeleting = task.status === 'deleting';
  const isCompleted = task.status === 'completed';

  return (
    <div className="py-6 px-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <Link to="/" className="text-sm text-gray-400 hover:text-white">
          &larr; Back to Dashboard
        </Link>
      </div>

      <div className="card">
        <div className="flex items-start gap-4 mb-6">
          {isFailed ? (
            <AlertCircleIcon className="w-8 h-8 text-red-400 shrink-0" />
          ) : isCompleted ? (
            <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center shrink-0">
              <CheckIcon className="w-5 h-5 text-white" />
            </div>
          ) : (
            <Spinner size="lg" className="text-red-400 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold mb-1">
              {isFailed
                ? 'Worktree Deletion Failed'
                : isCompleted
                  ? 'Worktree Deleted'
                  : 'Delete Worktree'}
            </h1>
            <p className="text-gray-400 text-sm">
              Session: <span className="text-gray-200">{task.sessionTitle}</span>
            </p>
          </div>
        </div>

        {/* Status */}
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Status</h2>
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
            isCompleted
              ? 'bg-green-500/20 text-green-400'
              : 'bg-red-500/20 text-red-400'
          }`}>
            {isFailed ? (
              <>
                <AlertCircleIcon className="w-4 h-4" />
                Failed
              </>
            ) : isCompleted ? (
              <>
                <CheckIcon className="w-4 h-4" />
                Deleted successfully
              </>
            ) : (
              <>
                <Spinner size="sm" />
                Deleting worktree...
              </>
            )}
          </div>
          {isCompleted && task.cleanupCommandResult && !task.cleanupCommandResult.success && (
            <div className="mt-3 p-3 bg-yellow-900/30 border border-yellow-600 rounded text-yellow-200 text-sm">
              <p className="font-medium">Cleanup command failed</p>
              {task.cleanupCommandResult.error && (
                <pre className="mt-1 text-xs text-yellow-300 whitespace-pre-wrap">{task.cleanupCommandResult.error}</pre>
              )}
              {task.cleanupCommandResult.output && (
                <pre className="mt-1 text-xs text-yellow-300/70 whitespace-pre-wrap">{task.cleanupCommandResult.output}</pre>
              )}
            </div>
          )}
          {isCompleted && task.killErrors && task.killErrors.length > 0 && (
            <div className="mt-3 p-3 bg-yellow-900/30 border border-yellow-600 rounded text-yellow-200 text-sm">
              <p className="font-medium">Some worker processes failed to stop</p>
              <ul className="mt-1 text-xs text-yellow-300 list-disc list-inside">
                {task.killErrors.map((ke) => (
                  <li key={ke.sessionId}>Session {ke.sessionId}: {ke.error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Error details (if failed) */}
        {isFailed && task.error && (
          <div className="mb-6">
            <h2 className="text-sm font-medium text-gray-400 mb-2">Error Details</h2>
            <div className="bg-slate-900 rounded p-3 text-sm text-red-400 font-mono whitespace-pre-wrap">
              {task.error}
            </div>
            {task.gitStatus && (
              <div className="mt-4">
                <h3 className="text-sm font-medium text-gray-400 mb-2">Git Status</h3>
                <pre className="bg-slate-900 p-3 rounded text-xs text-gray-300 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                  {task.gitStatus}
                </pre>
              </div>
            )}
            <p className="mt-2 text-xs text-gray-500">
              You can try force delete, which will remove the worktree even if there are
              uncommitted changes.
            </p>
          </div>
        )}

        {/* Timestamps */}
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Timing</h2>
          <p className="text-sm text-gray-300">
            Started: {new Date(task.createdAt).toLocaleString()}
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          {isFailed && (
            <button onClick={onForceDelete} className="btn btn-danger text-sm">
              Force Delete
            </button>
          )}
          <button
            onClick={onDismiss}
            className={`btn text-sm ${
              isCompleted ? 'btn-primary' : 'bg-slate-600 hover:bg-slate-500'
            }`}
            title={isDeleting ? 'Hide from list (deletion continues in background)' : undefined}
          >
            {isDeleting ? 'Hide' : 'Dismiss'}
          </button>
        </div>
      </div>

      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
