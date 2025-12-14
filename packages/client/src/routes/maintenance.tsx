import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { validateSessions, deleteInvalidSession } from '../lib/api';
import { formatPath } from '../lib/path';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { CheckIcon, WarningIcon, CloseIcon } from '../components/Icons';
import { useState } from 'react';
import type { SessionValidationResult } from '@agent-console/shared';

export const Route = createFileRoute('/maintenance')({
  component: MaintenancePage,
});

function MaintenancePage() {
  const queryClient = useQueryClient();
  const [sessionToDelete, setSessionToDelete] = useState<SessionValidationResult | null>(null);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['session-validation'],
    queryFn: validateSessions,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteInvalidSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-validation'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setSessionToDelete(null);
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: async (sessionIds: string[]) => {
      for (const id of sessionIds) {
        await deleteInvalidSession(id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-validation'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowDeleteAllConfirm(false);
    },
  });

  const invalidSessions = data?.results.filter(r => !r.valid) ?? [];

  return (
    <div className="py-6 px-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Maintenance</h1>
          <p className="text-sm text-gray-400 mt-1">
            Validate and clean up invalid sessions
          </p>
        </div>
        <Link to="/" className="btn text-sm bg-slate-700 hover:bg-slate-600 no-underline">
          Back to Dashboard
        </Link>
      </div>

      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium">Session Validation</h2>
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="btn text-sm bg-slate-700 hover:bg-slate-600"
          >
            {isLoading ? 'Validating...' : 'Validate All'}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/20 text-red-400 px-4 py-3 rounded mb-4">
            Failed to validate sessions: {error instanceof Error ? error.message : 'Unknown error'}
          </div>
        )}

        {data && !data.hasIssues && (
          <div className="bg-green-500/20 text-green-400 px-4 py-3 rounded flex items-center gap-2">
            <CheckIcon className="w-5 h-5" />
            All sessions are valid ({data.results.length} checked)
          </div>
        )}

        {data && data.hasIssues && (
          <>
            <div className="bg-yellow-500/20 text-yellow-400 px-4 py-3 rounded mb-4 flex items-center gap-2">
              <WarningIcon className="w-5 h-5" />
              {invalidSessions.length} invalid session{invalidSessions.length > 1 ? 's' : ''} found
            </div>

            {invalidSessions.length > 1 && (
              <div className="mb-4">
                <button
                  onClick={() => setShowDeleteAllConfirm(true)}
                  disabled={deleteAllMutation.isPending}
                  className="btn btn-danger text-sm"
                >
                  Delete All Invalid Sessions
                </button>
              </div>
            )}

            <div className="space-y-3">
              {invalidSessions.map((result) => (
                <InvalidSessionCard
                  key={result.sessionId}
                  result={result}
                  onDelete={() => setSessionToDelete(result)}
                  isDeleting={deleteMutation.isPending && sessionToDelete?.sessionId === result.sessionId}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Delete single session confirmation */}
      <ConfirmDialog
        open={sessionToDelete !== null}
        onOpenChange={(open) => !open && setSessionToDelete(null)}
        title="Delete Invalid Session"
        description={`Delete session at "${sessionToDelete?.session.locationPath}"? This will remove the session from the configuration.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => sessionToDelete && deleteMutation.mutate(sessionToDelete.sessionId)}
        isLoading={deleteMutation.isPending}
      />

      {/* Delete all confirmation */}
      <ConfirmDialog
        open={showDeleteAllConfirm}
        onOpenChange={setShowDeleteAllConfirm}
        title="Delete All Invalid Sessions"
        description={`Delete all ${invalidSessions.length} invalid sessions? This cannot be undone.`}
        confirmLabel="Delete All"
        variant="danger"
        onConfirm={() => deleteAllMutation.mutate(invalidSessions.map(r => r.sessionId))}
        isLoading={deleteAllMutation.isPending}
      />
    </div>
  );
}

interface InvalidSessionCardProps {
  result: SessionValidationResult;
  onDelete: () => void;
  isDeleting: boolean;
}

function InvalidSessionCard({ result, onDelete, isDeleting }: InvalidSessionCardProps) {
  const { session, issues } = result;

  return (
    <div className="bg-slate-800 rounded p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {session.title && (
            <div className="text-sm font-medium text-gray-200 mb-1 truncate" title={session.title}>
              {session.title}
            </div>
          )}
          <div className="text-sm text-gray-400 truncate" title={session.locationPath}>
            {formatPath(session.locationPath)}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-gray-500 capitalize">{session.type}</span>
            {session.worktreeId && (
              <>
                <span className="text-xs text-gray-600">|</span>
                <span className="text-xs text-gray-500">{session.worktreeId}</span>
              </>
            )}
          </div>
          <div className="mt-2 space-y-1">
            {issues.map((issue, index) => (
              <div key={index} className="flex items-center gap-2 text-xs text-red-400">
                <CloseIcon className="w-3.5 h-3.5 shrink-0" />
                <span>{getIssueMessage(issue.type)}</span>
              </div>
            ))}
          </div>
        </div>
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="btn btn-danger text-xs shrink-0"
        >
          {isDeleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

function getIssueMessage(type: string): string {
  switch (type) {
    case 'directory_not_found':
      return 'Directory does not exist';
    case 'not_git_repository':
      return 'Not a git repository';
    case 'branch_not_found':
      return 'Branch does not exist';
    default:
      return type;
  }
}
