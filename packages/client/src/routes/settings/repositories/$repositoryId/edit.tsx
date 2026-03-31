import {
  createFileRoute,
  useNavigate,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { fetchRepositories } from '../../../../lib/api';
import { repositoryKeys } from '../../../../lib/query-keys';
import { PageBreadcrumb } from '../../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../../components/PageErrorFallback';
import { EditRepositoryForm } from '../../../../components/repositories/EditRepositoryForm';

export const Route = createFileRoute('/settings/repositories/$repositoryId/edit')({
  component: RepositoryEditPage,
  pendingComponent: RepositoryEditPending,
  errorComponent: RepositoryEditError,
});

export function RepositoryEditPending() {
  return <PagePendingFallback message="Loading repository..." />;
}

export function RepositoryEditError({ error, reset }: ErrorComponentProps) {
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
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Repositories', to: '/settings/repositories' },
        { label: repository.name, to: '/settings/repositories/$repositoryId', params: { repositoryId } },
        { label: 'Edit' },
      ]} />

      <h1 className="text-2xl font-semibold mb-6">Edit Repository</h1>

      <EditRepositoryForm
        repository={repository}
        onSuccess={navigateToDetail}
        onCancel={navigateToDetail}
      />
    </div>
  );
}
