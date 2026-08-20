import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Artifact } from '@agent-console/shared';
import { fetchArtifacts, deleteArtifact } from '../../lib/api';
import { artifactKeys } from '../../lib/query-keys';
import { formatTimestamp, formatBytes } from '../../lib/format';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { Spinner } from '../../components/ui/Spinner';

export const Route = createFileRoute('/artifacts/')({
  component: ArtifactsPage,
  head: () => ({
    meta: [{ title: 'Artifacts' }],
  }),
});

export function ArtifactsPage() {
  const queryClient = useQueryClient();
  const { errorDialogProps, showError } = useErrorDialog();

  // Artifact to delete (for confirmation dialog)
  const [artifactToDelete, setArtifactToDelete] = useState<Artifact | null>(null);

  const {
    data: artifacts,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: artifactKeys.list(),
    queryFn: () => fetchArtifacts(),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteArtifact,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: artifactKeys.root() });
      setArtifactToDelete(null);
    },
    onError: (err) => {
      setArtifactToDelete(null);
      showError('Failed to Delete Artifact', err.message);
    },
  });

  const handleDeleteClick = (artifact: Artifact) => {
    setArtifactToDelete(artifact);
  };

  const handleConfirmDelete = () => {
    if (artifactToDelete) {
      deleteMutation.mutate(artifactToDelete.id);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Breadcrumb */}
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Artifacts' },
      ]} />

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Artifacts</h1>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="btn text-sm bg-slate-700 hover:bg-slate-600"
        >
          {isFetching ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading artifacts...</span>
        </div>
      )}

      {/* Error State */}
      {!isLoading && error && (
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Failed to load artifacts</p>
          <button onClick={() => refetch()} className="btn btn-primary">
            Retry
          </button>
        </div>
      )}

      {/* Artifacts Table */}
      {!isLoading && !error && artifacts && artifacts.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left py-3 px-4 font-medium text-gray-400">Title</th>
                <th className="text-left py-3 px-4 font-medium text-gray-400">Created</th>
                <th className="text-left py-3 px-4 font-medium text-gray-400">Size</th>
                <th className="text-right py-3 px-4 font-medium text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.map((artifact) => (
                <ArtifactRow
                  key={artifact.id}
                  artifact={artifact}
                  onDelete={handleDeleteClick}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && artifacts && artifacts.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-gray-500">No artifacts found</p>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={artifactToDelete !== null}
        onOpenChange={(open) => !open && setArtifactToDelete(null)}
        title="Delete Artifact"
        description={`Are you sure you want to delete "${artifactToDelete?.title ?? ''}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleConfirmDelete}
        isLoading={deleteMutation.isPending}
      />

      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

interface ArtifactRowProps {
  artifact: Artifact;
  onDelete: (artifact: Artifact) => void;
}

function ArtifactRow({ artifact, onDelete }: ArtifactRowProps) {
  return (
    <tr className="border-b border-slate-700/50 hover:bg-slate-800/50">
      <td className="py-3 px-4">{artifact.title}</td>
      <td className="py-3 px-4 text-gray-400">
        {formatTimestamp(new Date(artifact.createdAt).getTime())}
      </td>
      <td className="py-3 px-4 text-gray-400">{formatBytes(artifact.sizeBytes)}</td>
      <td className="py-3 px-4 text-right">
        <div className="flex justify-end gap-2">
          <a
            href={`/artifacts/${artifact.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn text-xs bg-blue-600 hover:bg-blue-500 no-underline"
          >
            View
          </a>
          <button
            onClick={() => onDelete(artifact)}
            className="btn btn-danger text-xs"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}
