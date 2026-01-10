import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { WorktreeCreationTask, CreateWorktreeRequest } from '@agent-console/shared';
import { AlertCircleIcon } from '../../components/Icons';
import { Spinner } from '../../components/ui/Spinner';
import { useWorktreeCreationTasksContext } from '../__root';
import { createWorktreeAsync } from '../../lib/api';

export const Route = createFileRoute('/worktree-creation-tasks/$taskId')({
  component: WorktreeCreationTaskPage,
});

/**
 * Hook to access and manage a worktree creation task from context.
 */
function useWorktreeCreationTask(taskId: string): {
  task: WorktreeCreationTask | undefined;
  removeTask: () => void;
  retryTask: () => Promise<void>;
} {
  const navigate = useNavigate();
  const {
    getTask,
    removeTask: removeTaskFromContext,
    addTask,
    handleWorktreeCreationFailed,
  } = useWorktreeCreationTasksContext();

  const task = getTask(taskId);

  const removeTask = () => {
    removeTaskFromContext(taskId);
    navigate({ to: '/' });
  };

  const retryTask = async () => {
    if (!task) return;

    // Generate a new task ID for the retry
    const newTaskId = crypto.randomUUID();

    // Build new request with new taskId
    const newRequest = { ...task.request, taskId: newTaskId };

    // Remove the failed task
    removeTaskFromContext(taskId);

    // Add a new task
    addTask({
      id: newTaskId,
      repositoryId: task.repositoryId,
      repositoryName: task.repositoryName,
      request: newRequest,
    });

    // Call the API
    try {
      await createWorktreeAsync(task.repositoryId, newRequest);
    } catch (error) {
      // Update the new task to failed state so user can see the error in sidebar
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      handleWorktreeCreationFailed({ taskId: newTaskId, error: errorMessage });
      console.error('Failed to retry worktree creation:', error);
      // Navigate to the new failed task's detail page
      navigate({ to: '/worktree-creation-tasks/$taskId', params: { taskId: newTaskId } });
      return;
    }

    // Navigate back to dashboard
    navigate({ to: '/' });
  };

  return { task, removeTask, retryTask };
}

function WorktreeCreationTaskPage() {
  const { taskId } = Route.useParams();
  const { task, removeTask, retryTask } = useWorktreeCreationTask(taskId);

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
  const isCreating = task.status === 'creating';

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
          ) : (
            <Spinner size="lg" className="text-blue-400 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold mb-1">
              {isFailed ? 'Worktree Creation Failed' : 'Creating Worktree...'}
            </h1>
            <p className="text-gray-400 text-sm">
              Repository: <span className="text-gray-200">{task.repositoryName}</span>
            </p>
          </div>
        </div>

        {/* Status */}
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Status</h2>
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
            isFailed
              ? 'bg-red-500/20 text-red-400'
              : 'bg-blue-500/20 text-blue-400'
          }`}>
            {isFailed ? (
              <>
                <AlertCircleIcon className="w-4 h-4" />
                Failed
              </>
            ) : (
              <>
                <Spinner size="sm" />
                Creating...
              </>
            )}
          </div>
        </div>

        {/* Error details (if failed) */}
        {isFailed && task.error && (
          <div className="mb-6">
            <h2 className="text-sm font-medium text-gray-400 mb-2">Error Details</h2>
            <div className="bg-slate-900 rounded p-3 text-sm text-red-400 font-mono whitespace-pre-wrap">
              {task.error}
            </div>
          </div>
        )}

        {/* Creation parameters */}
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Creation Parameters</h2>
          <CreationParametersDisplay request={task.request} />
        </div>

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
            <button onClick={retryTask} className="btn btn-primary text-sm">
              Retry
            </button>
          )}
          <button
            onClick={removeTask}
            className={`btn text-sm ${isFailed ? 'btn-danger' : 'bg-slate-600 hover:bg-slate-500'}`}
            title={isCreating ? 'Hide from list (creation continues in background)' : undefined}
          >
            {isCreating ? 'Hide' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CreationParametersDisplayProps {
  request: CreateWorktreeRequest;
}

function CreationParametersDisplay({ request }: CreationParametersDisplayProps) {
  return (
    <div className="bg-slate-900 rounded p-3 text-sm space-y-2">
      <div>
        <span className="text-gray-500">Mode: </span>
        <span className="text-gray-300">{request.mode}</span>
      </div>
      {request.mode === 'prompt' && (
        <div>
          <span className="text-gray-500">Initial Prompt: </span>
          <span className="text-gray-300 whitespace-pre-wrap">{request.initialPrompt}</span>
        </div>
      )}
      {(request.mode === 'custom' || request.mode === 'existing') && (
        <div>
          <span className="text-gray-500">Branch: </span>
          <span className="text-gray-300">{request.branch}</span>
        </div>
      )}
      {request.mode !== 'existing' && request.baseBranch && (
        <div>
          <span className="text-gray-500">Base Branch: </span>
          <span className="text-gray-300">{request.baseBranch}</span>
        </div>
      )}
      {request.title && (
        <div>
          <span className="text-gray-500">Title: </span>
          <span className="text-gray-300">{request.title}</span>
        </div>
      )}
      {request.agentId && (
        <div>
          <span className="text-gray-500">Agent: </span>
          <span className="text-gray-300">{request.agentId}</span>
        </div>
      )}
    </div>
  );
}
