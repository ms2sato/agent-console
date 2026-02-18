import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { WorktreeDeletionTask } from '@agent-console/shared';
import { AlertCircleIcon, CheckIcon } from '../../components/Icons';
import { Spinner } from '../../components/ui/Spinner';
import { useWorktreeDeletionTasksContext } from '../__root';
import { deleteWorktreeAsync } from '../../lib/api';
import { generateTaskId } from '../../lib/id';

export const Route = createFileRoute('/worktree-deletion-tasks/$taskId')({
  component: WorktreeDeletionTaskPage,
});

/**
 * Hook to access and manage a worktree deletion task from context.
 */
function useWorktreeDeletionTask(taskId: string): {
  task: WorktreeDeletionTask | undefined;
  removeTask: () => void;
  forceDelete: () => Promise<void>;
} {
  const navigate = useNavigate();
  const {
    getTask,
    removeTask: removeTaskFromContext,
    addTask,
    markAsFailed,
  } = useWorktreeDeletionTasksContext();

  const task = getTask(taskId);

  const removeTask = () => {
    removeTaskFromContext(taskId);
    navigate({ to: '/' });
  };

  const forceDelete = async () => {
    if (!task) return;

    // Generate a new task ID for the retry
    const newTaskId = generateTaskId();

    // Remove the failed task
    removeTaskFromContext(taskId);

    // Add a new task
    addTask({
      id: newTaskId,
      sessionId: task.sessionId,
      sessionTitle: task.sessionTitle,
      repositoryId: task.repositoryId,
      worktreePath: task.worktreePath,
    });

    // Navigate to the new task's detail page
    navigate({ to: '/worktree-deletion-tasks/$taskId', params: { taskId: newTaskId } });

    // Call the API with force=true
    try {
      await deleteWorktreeAsync(task.repositoryId, task.worktreePath, newTaskId, true);
      // Success will be handled via WebSocket
    } catch (error) {
      // Update the new task to failed state
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      markAsFailed(newTaskId, errorMessage);
      console.error('Failed to force delete worktree:', error);
    }
  };

  return { task, removeTask, forceDelete };
}

function WorktreeDeletionTaskPage() {
  const { taskId } = Route.useParams();
  const { task, removeTask, forceDelete } = useWorktreeDeletionTask(taskId);

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="card text-center max-w-md">
          <h2 className="text-xl font-semibold mb-4">Task Not Found</h2>
          <p className="text-gray-400 mb-6">
            This task no longer exists or has been completed.
          </p>
          <Link to="/" className="btn btn-primary no-underline">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

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
            <button onClick={forceDelete} className="btn btn-danger text-sm">
              Force Delete
            </button>
          )}
          <button
            onClick={removeTask}
            className={`btn text-sm ${
              isCompleted ? 'btn-primary' : 'bg-slate-600 hover:bg-slate-500'
            }`}
            title={isDeleting ? 'Hide from list (deletion continues in background)' : undefined}
          >
            {isDeleting ? 'Hide' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
}
