import {
  createFileRoute,
  Link,
  useNavigate,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { fetchRepositories } from '../../../../lib/api';
import { repositoryKeys } from '../../../../lib/query-keys';
import { EditRepositoryForm } from '../../../../components/repositories/EditRepositoryForm';
import { Spinner } from '../../../../components/ui/Spinner';

export const Route = createFileRoute('/settings/repositories/$repositoryId/edit')({
  component: RepositoryEditPage,
  pendingComponent: RepositoryEditPending,
  errorComponent: RepositoryEditError,
});

export function RepositoryEditPending() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-gray-500">
        <Spinner size="sm" />
        <span>Loading repository...</span>
      </div>
    </div>
  );
}

export function RepositoryEditError({ error, reset }: ErrorComponentProps) {
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

function RepositoryEditPage() {
  const { repositoryId } = Route.useParams();
  const navigate = useNavigate();

  const { data } = useSuspenseQuery({
    queryKey: repositoryKeys.all(),
    queryFn: fetchRepositories,
  });

  const repository = data.repositories.find((r) => r.id === repositoryId);
  if (!repository) {
    throw new Error(`Repository not found: ${repositoryId}`);
  }

  const navigateToDetail = () => {
    navigate({ to: '/settings/repositories/$repositoryId', params: { repositoryId } });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <Link to="/settings/repositories" className="hover:text-white">Repositories</Link>
        <span>/</span>
        <Link to="/settings/repositories/$repositoryId" params={{ repositoryId }} className="hover:text-white">
          {repository.name}
        </Link>
        <span>/</span>
        <span className="text-white">Edit</span>
      </div>

      <h1 className="text-2xl font-semibold mb-6">Edit Repository</h1>

      <EditRepositoryForm
        repository={repository}
        onSuccess={navigateToDetail}
        onCancel={navigateToDetail}
      />
    </div>
  );
}
