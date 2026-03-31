import { createFileRoute } from '@tanstack/react-router';
import { PageBreadcrumb } from '../../../components/PageBreadcrumb';
import { RepositoryList } from '../../../components/repositories/RepositoryList';

export const Route = createFileRoute('/settings/repositories/')({
  component: RepositoriesPage,
});

function RepositoriesPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Repositories' },
      ]} />

      {/* Header */}
      <h1 className="text-2xl font-semibold mb-2">Repository Settings</h1>
      <p className="text-gray-400 mb-8">
        Configure setup commands that run automatically after creating a new worktree for each repository.
      </p>

      {/* Repository List */}
      <RepositoryList />
    </div>
  );
}
