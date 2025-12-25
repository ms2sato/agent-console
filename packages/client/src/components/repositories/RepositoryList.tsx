import { useState } from 'react';
import type { Repository } from '@agent-console/shared';
import { useRepositories } from '../../hooks/use-repositories';
import { Spinner } from '../ui/Spinner';
import { EditRepositoryForm } from './EditRepositoryForm';

// Extended Repository type that includes setupCommand
type RepositoryWithSetup = Repository & { setupCommand?: string | null };

export function RepositoryList() {
  const { repositories, isLoading, error, refetch } = useRepositories();
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);

  // Show loading state only while initial fetch is in progress
  const showLoading = isLoading;

  if (showLoading) {
    return (
      <div className="flex items-center gap-2 text-gray-500">
        <Spinner size="sm" />
        <span>Loading repositories...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card text-center py-10">
        <p className="text-red-400 mb-4">Failed to load repositories</p>
        <button onClick={() => refetch()} className="btn btn-primary">
          Retry
        </button>
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="card text-center py-10">
        <p className="text-gray-500 mb-4">No repositories registered</p>
        <p className="text-sm text-gray-600">
          Register repositories from the Dashboard to manage their setup commands.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {repositories.map((repo) => {
        const repoWithSetup = repo as RepositoryWithSetup;
        const isEditing = editingRepoId === repo.id;

        if (isEditing) {
          return (
            <EditRepositoryForm
              key={repo.id}
              repository={repoWithSetup}
              onSuccess={() => setEditingRepoId(null)}
              onCancel={() => setEditingRepoId(null)}
            />
          );
        }

        return (
          <RepositoryCard
            key={repo.id}
            repository={repoWithSetup}
            onEdit={() => setEditingRepoId(repo.id)}
          />
        );
      })}
    </div>
  );
}

interface RepositoryCardProps {
  repository: RepositoryWithSetup;
  onEdit: () => void;
}

function RepositoryCard({ repository, onEdit }: RepositoryCardProps) {
  const { setupCommand } = repository;
  const hasSetupCommand = Boolean(setupCommand?.trim());

  return (
    <div className="card">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          {/* Name */}
          <div className="text-lg font-medium mb-1">{repository.name}</div>

          {/* Path */}
          <div className="text-sm text-gray-400 font-mono mb-2">{repository.path}</div>

          {/* Setup command */}
          <div className="text-sm">
            <span className="text-gray-500">Setup command: </span>
            {hasSetupCommand ? (
              <span
                className="font-mono text-gray-300 truncate inline-block max-w-[400px] align-bottom"
                title={setupCommand || undefined}
              >
                {truncateCommand(setupCommand!, 60)}
              </span>
            ) : (
              <span className="text-gray-600 italic">Not configured</span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 shrink-0">
          <button
            onClick={onEdit}
            className="btn btn-primary text-sm"
          >
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Truncate a command string to a maximum length with ellipsis.
 * Preserves the beginning of the command which is most informative.
 */
function truncateCommand(command: string, maxLength: number): string {
  if (command.length <= maxLength) {
    return command;
  }
  return command.slice(0, maxLength - 3) + '...';
}
