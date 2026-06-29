import { useState } from 'react';
import {
  createFileRoute,
  Link,
  useNavigate,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { useSuspenseQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchRepository, unregisterRepository, fetchAgents } from '../../../../lib/api';
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
  return <RepositoryDetailView repositoryId={repositoryId} />;
}

/**
 * Presentational view for the repository detail page. Exposed (and exported)
 * so route-level tests can mount it without the TanStack Router route tree.
 * Production callers go through `RepositoryDetailPage` which reads
 * `repositoryId` from the route params.
 */
export function RepositoryDetailView({ repositoryId }: { repositoryId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Opt-in for deleting the cloned source repo; only meaningful (and only
  // rendered as a checkbox) when `repository.clonedSourceRepoPath != null`.
  const [removeSourceRepo, setRemoveSourceRepo] = useState(false);
  const { errorDialogProps, showError } = useErrorDialog();

  const { data } = useSuspenseQuery({
    queryKey: repositoryKeys.detail(repositoryId),
    queryFn: () => fetchRepository(repositoryId),
  });

  const repository = data.repository;

  // Look up agent name for defaultAgentId
  const { data: agentsData } = useQuery({
    queryKey: agentKeys.all(),
    queryFn: fetchAgents,
    enabled: !!repository.defaultAgentId,
  });

  const defaultAgentName = repository.defaultAgentId
    ? agentsData?.agents.find((a) => a.id === repository.defaultAgentId)?.name
    : undefined;

  const deleteMutation = useMutation({
    mutationFn: ({ id, removeSourceRepo: remove }: { id: string; removeSourceRepo: boolean }) =>
      unregisterRepository(id, remove ? { removeSourceRepo: true } : undefined),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: repositoryKeys.detail(repositoryId) });
      navigate({ to: '/settings/repositories' });
    },
    onError: (error) => {
      setShowDeleteConfirm(false);
      setRemoveSourceRepo(false);
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
        onOpenChange={(open) => {
          setShowDeleteConfirm(open);
          if (!open) setRemoveSourceRepo(false);
        }}
        title="Delete Repository"
        description={`Are you sure you want to delete "${repository.name}"?`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteMutation.mutate({ id: repositoryId, removeSourceRepo })}
        isLoading={deleteMutation.isPending}
      >
        {repository.clonedSourceRepoPath != null && (
          <label className="flex items-start gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={removeSourceRepo}
              onChange={(e) => setRemoveSourceRepo(e.target.checked)}
              className="mt-0.5 accent-indigo-600"
            />
            <span>
              Also remove the cloned source repository at{' '}
              <code className="text-xs text-gray-400 break-all">{repository.clonedSourceRepoPath}</code>
            </span>
          </label>
        )}
      </ConfirmDialog>
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
