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
import { PageBreadcrumb } from '../../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../../components/PageErrorFallback';
import { ConfirmDialog } from '../../../../components/ui/confirm-dialog';
import { SectionHeader, DetailRow } from '../../../../components/ui/detail-layout';
import { ErrorDialog, useErrorDialog } from '../../../../components/ui/error-dialog';

export const Route = createFileRoute('/settings/repositories/$repositoryId/')({
  component: RepositoryDetailPage,
  pendingComponent: RepositoryDetailPending,
  errorComponent: RepositoryDetailError,
});

export function RepositoryDetailPending() {
  return <PagePendingFallback message="Loading repository..." />;
}

export function RepositoryDetailError({ error, reset }: ErrorComponentProps) {
  return (
    <PageErrorFallback
      error={error}
      reset={reset}
      breadcrumbItems={[
        { label: 'Agent Console', to: '/' },
        { label: 'Repositories', to: '/settings/repositories' },
        { label: 'Error' },
      ]}
      errorMessage="Failed to load repository"
      backTo="/settings/repositories"
      backLabel="Back to Repositories"
    />
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
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Repositories', to: '/settings/repositories' },
        { label: repository.name },
      ]} />

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
