import { createFileRoute, Link } from '@tanstack/react-router';
import { RepositoryList } from '../../components/repositories/RepositoryList';

export const Route = createFileRoute('/settings/repositories')({
  component: RepositoriesPage,
});

function RepositoriesPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <span className="text-white">Repositories</span>
      </div>

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
