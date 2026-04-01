import { useQuery } from '@tanstack/react-query';
import { fetchRepository, fetchBranches } from '../../lib/api';
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
  repositoryId: string;
  repositoryName: string;
}

export function QuickWorktreeDialog({
  open,
  onOpenChange,
  repositoryId,
  repositoryName,
}: QuickWorktreeDialogProps) {
  const repositoryQuery = useQuery({
    queryKey: repositoryKeys.detail(repositoryId),
    queryFn: () => fetchRepository(repositoryId),
    enabled: open,
  });

  const branchesQuery = useQuery({
    queryKey: branchKeys.byRepository(repositoryId),
    queryFn: () => fetchBranches(repositoryId),
    enabled: open,
  });

  const { handleCreateWorktree, error, clearError } = useCreateWorktree({
    repositoryId,
    repositoryName,
  });

  const isLoading = repositoryQuery.isLoading || branchesQuery.isLoading;
  const defaultBranch = branchesQuery.data?.defaultBranch ?? 'main';
  const defaultAgentId = repositoryQuery.data?.repository.defaultAgentId;

  const handleSubmit = async (...args: Parameters<typeof handleCreateWorktree>) => {
    try {
      await handleCreateWorktree(...args);
      onOpenChange(false);
    } catch {
      // Error is captured in useCreateWorktree's error state and shown below
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) clearError();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Worktree</DialogTitle>
          <DialogDescription>
            Create a new worktree for {repositoryName}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-red-400 mb-2" role="alert">{error}</p>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : (
          <CreateWorktreeForm
            repositoryId={repositoryId}
            defaultBranch={defaultBranch}
            defaultAgentId={defaultAgentId}
            onSubmit={handleSubmit}
            onCancel={() => handleOpenChange(false)}
            draftKey={`worktree-draft:${repositoryId}`}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
