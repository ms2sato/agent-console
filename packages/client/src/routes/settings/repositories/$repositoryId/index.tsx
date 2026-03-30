import { useState } from 'react';
import {
  createFileRoute,
  Link,
  useNavigate,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { useSuspenseQuery, useQuery, useMutation } from '@tanstack/react-query';
import { fetchRepositories, unregisterRepository, fetchAgents } from '../../../../lib/api';
import { repositoryKeys, agentKeys } from '../../../../lib/query-keys';
import { ConfirmDialog } from '../../../../components/ui/confirm-dialog';
import { SectionHeader, DetailRow } from '../../../../components/ui/detail-layout';
import { ErrorDialog, useErrorDialog } from '../../../../components/ui/error-dialog';
import { Spinner } from '../../../../components/ui/Spinner';

export const Route = createFileRoute('/settings/repositories/$repositoryId/')({
  component: RepositoryDetailPage,
  pendingComponent: RepositoryDetailPending,
  errorComponent: RepositoryDetailError,
});

export function RepositoryDetailPending() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-gray-500">
        <Spinner size="sm" />
        <span>Loading repository...</span>
      </div>
    </div>
  );
}

export function RepositoryDetailError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <Link to="/settings/repositories" className="hover:text-white">Repositories</Link>
        <span>/</span>
        <span className="text-white">Error</span>
      </div>
      <div className="card text-center py-10">
        <p className="text-red-400 mb-2">Failed to load repository</p>
        <p className="text-gray-500 text-sm mb-4">{error.message}</p>
        <div className="flex justify-center gap-2">
          <button onClick={reset} className="btn btn-secondary">
            Retry
          </button>
          <Link to="/settings/repositories" className="btn btn-primary">
            Back to Repositories
          </Link>
        </div>
      </div>
    </div>
  );
}

function RepositoryDetailPage() {
  const { repositoryId } = Route.useParams();
  const navigate = useNavigate();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { errorDialogProps, showError } = useErrorDialog();

  const { data } = useSuspenseQuery({
    queryKey: repositoryKeys.all(),
    queryFn: fetchRepositories,
  });

  const repository = data.repositories.find((r) => r.id === repositoryId);

  // Look up agent name for defaultAgentId
  // Must be called before the conditional throw to maintain hook order
  const { data: agentsData } = useQuery({
    queryKey: agentKeys.all(),
    queryFn: fetchAgents,
    enabled: !!repository?.defaultAgentId,
  });

  const defaultAgentName = repository?.defaultAgentId
    ? agentsData?.agents.find((a) => a.id === repository.defaultAgentId)?.name
    : undefined;

  if (!repository) {
    throw new Error(`Repository not found: ${repositoryId}`);
  }

  const deleteMutation = useMutation({
    mutationFn: unregisterRepository,
    onSuccess: () => {
      navigate({ to: '/settings/repositories' });
    },
    onError: (error) => {
      setShowDeleteConfirm(false);
      showError('Cannot Delete Repository', error.message);
    },
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <Link to="/settings/repositories" className="hover:text-white">Repositories</Link>
        <span>/</span>
        <span className="text-white">{repository.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">{repository.name}</h1>
        <div className="flex gap-2">
          <Link
            to="/settings/repositories/$repositoryId/edit"
            params={{ repositoryId }}
            className="btn btn-primary text-sm no-underline"
          >
            Edit
          </Link>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="btn btn-danger text-sm"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Repository Details */}
      <div className="card">
        {/* Description */}
        {repository.description && (
          <div className="mb-6">
            <p className="text-gray-300">{repository.description}</p>
          </div>
        )}

        {/* Configuration Section */}
        <SectionHeader title="Configuration" />
        <div className="space-y-4 mb-6">
          <DetailRow label="Path" value={repository.path} mono />
          <DetailRow
            label="Setup Command"
            value={repository.setupCommand || '(not set)'}
            mono
            muted={!repository.setupCommand}
          />
          <DetailRow
            label="Cleanup Command"
            value={repository.cleanupCommand || '(not set)'}
            mono
            muted={!repository.cleanupCommand}
          />
          <DetailRow
            label="Env Variables"
            value={repository.envVars || '(not set)'}
            mono
            muted={!repository.envVars}
          />
        </div>

        {/* Default Agent Section */}
        <SectionHeader title="Default Agent" />
        <div className="space-y-4 mb-6">
          <DetailRow
            label="Agent"
            value={defaultAgentName || '(not set)'}
            muted={!defaultAgentName}
          />
        </div>

        {/* Metadata Section */}
        <SectionHeader title="Metadata" />
        <div className="space-y-2 text-sm text-gray-500">
          <div>
            <span className="text-gray-400">ID:</span>{' '}
            <span className="font-mono">{repository.id}</span>
          </div>
          <div>
            <span className="text-gray-400">Created:</span>{' '}
            {new Date(repository.createdAt).toLocaleString()}
          </div>
        </div>
      </div>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Repository"
        description={`Are you sure you want to delete "${repository.name}"?`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteMutation.mutate(repositoryId)}
        isLoading={deleteMutation.isPending}
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
