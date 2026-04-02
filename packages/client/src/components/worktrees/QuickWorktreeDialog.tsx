import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchRepository, fetchBranches, fetchRepositories } from '../../lib/api';
import { repositoryKeys, branchKeys } from '../../lib/query-keys';
import { useCreateWorktree } from '../../hooks/useCreateWorktree';
import { Spinner } from '../ui/Spinner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { CreateWorktreeForm } from './CreateWorktreeForm';

interface QuickWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, skip repository selection */
  defaultRepositoryId?: string;
}

export function QuickWorktreeDialog({
  open,
  onOpenChange,
  defaultRepositoryId,
}: QuickWorktreeDialogProps) {
  // Fetch all repositories for the selector
  const repositoriesQuery = useQuery({
    queryKey: repositoryKeys.all(),
    queryFn: fetchRepositories,
    enabled: open,
  });

  const repositories = repositoriesQuery.data?.repositories ?? [];

  // Selected repository ID: use default if provided, otherwise first available
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>(defaultRepositoryId);

  // Reset selection when dialog opens or default changes
  useEffect(() => {
    if (open) {
      setSelectedRepoId(defaultRepositoryId);
    }
  }, [open, defaultRepositoryId]);

  // If no explicit selection yet but repositories loaded, pick first
  const effectiveRepoId = selectedRepoId ?? repositories[0]?.id;
  const selectedRepo = repositories.find(r => r.id === effectiveRepoId);

  const repositoryQuery = useQuery({
    queryKey: repositoryKeys.detail(effectiveRepoId!),
    queryFn: () => fetchRepository(effectiveRepoId!),
    enabled: open && !!effectiveRepoId,
  });

  const branchesQuery = useQuery({
    queryKey: branchKeys.byRepository(effectiveRepoId!),
    queryFn: () => fetchBranches(effectiveRepoId!),
    enabled: open && !!effectiveRepoId,
  });

  const { handleCreateWorktree, error, clearError } = useCreateWorktree({
    repositoryId: effectiveRepoId ?? '',
    repositoryName: selectedRepo?.name ?? '',
  });

  const isLoading = repositoriesQuery.isLoading || repositoryQuery.isLoading || branchesQuery.isLoading;
  const defaultBranch = branchesQuery.data?.defaultBranch ?? 'main';
  const defaultAgentId = repositoryQuery.data?.repository.defaultAgentId;

  const handleSubmit = async (...args: Parameters<typeof handleCreateWorktree>) => {
    try {
      await handleCreateWorktree(...args);
      onOpenChange(false);
    } catch {
      // Error is captured in useCreateWorktree's error state
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) clearError();
    onOpenChange(nextOpen);
  };

  const showRepoSelector = repositories.length > 1 || !defaultRepositoryId;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Create Worktree</DialogTitle>
          <DialogDescription>
            {selectedRepo
              ? `Create a new worktree for ${selectedRepo.name}`
              : 'Select a repository and create a new worktree'}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-red-400 mb-2" role="alert">{error}</p>
        )}
        {/* Repository selector */}
        {showRepoSelector && !repositoriesQuery.isLoading && repositories.length > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <label htmlFor="repo-selector" className="text-sm text-gray-400 shrink-0">Repository:</label>
            <select
              id="repo-selector"
              value={effectiveRepoId ?? ''}
              onChange={(e) => setSelectedRepoId(e.target.value)}
              className="flex-1 min-w-0 bg-slate-700 text-sm text-gray-200 rounded px-2 py-1.5 border border-slate-600 focus:border-blue-500 focus:outline-none"
            >
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>{repo.name}</option>
              ))}
            </select>
          </div>
        )}
        {repositoriesQuery.isLoading || !effectiveRepoId || isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : (
          <CreateWorktreeForm
            repositoryId={effectiveRepoId}
            defaultBranch={defaultBranch}
            defaultAgentId={defaultAgentId}
            onSubmit={handleSubmit}
            onCancel={() => handleOpenChange(false)}
            draftKey={`worktree-draft:${effectiveRepoId}`}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
