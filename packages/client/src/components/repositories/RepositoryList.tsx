import { Link } from '@tanstack/react-router';
import type { Repository } from '@agent-console/shared';
import { useRepositories } from './hooks/use-repositories';
import { Spinner } from '../ui/Spinner';

export function RepositoryList() {
  const { repositories, isLoading, error, refetch } = useRepositories();

  if (isLoading) {
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
      {repositories.map((repo) => (
        <RepositoryCard key={repo.id} repository={repo} />
      ))}
    </div>
  );
}

interface RepositoryCardProps {
  repository: Repository;
}

function RepositoryCard({ repository }: RepositoryCardProps) {
  const { setupCommand } = repository;
  const hasSetupCommand = Boolean(setupCommand?.trim());

  return (
    <Link
      to="/settings/repositories/$repositoryId"
      params={{ repositoryId: repository.id }}
      className="card hover:border-slate-600 transition-colors cursor-pointer no-underline block"
    >
      <div className="text-lg font-medium mb-1">{repository.name}</div>
      <div className="text-sm text-gray-400 font-mono mb-2">{repository.path}</div>
      {repository.description && (
        <div className="text-sm mb-2">
          <span className="text-gray-500">Description: </span>
          <span className="text-gray-300">{repository.description}</span>
        </div>
      )}
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
    </Link>
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
