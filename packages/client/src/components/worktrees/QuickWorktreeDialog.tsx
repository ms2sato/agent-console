import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { fetchRepository, fetchBranches, fetchRepositories, createSession } from '../../lib/api';
import { repositoryKeys, branchKeys, sessionKeys } from '../../lib/query-keys';
import { useCreateWorktree } from '../../hooks/useCreateWorktree';
import { Spinner } from '../ui/Spinner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { CreateWorktreeForm } from './CreateWorktreeForm';
import { QuickSessionForm } from '../sessions/QuickSessionForm';
import { FromIssueTab } from './FromIssueTab';
import type { CreateQuickSessionRequest } from '@agent-console/shared';

const TABS = {
  worktree: 'Create Worktree',
  quickstart: 'Quick Start',
  fromissue: 'Create from Issue',
} as const;

type TabId = keyof typeof TABS;

interface QuickWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects this repository when the dialog opens */
  defaultRepositoryId?: string;
}

export function QuickWorktreeDialog({
  open,
  onOpenChange,
  defaultRepositoryId,
}: QuickWorktreeDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>('worktree');

  // Fetch all repositories for the selector
  const repositoriesQuery = useQuery({
    queryKey: repositoryKeys.all(),
    queryFn: fetchRepositories,
    enabled: open,
  });

  const repositories = repositoriesQuery.data?.repositories ?? [];

  // Selected repository ID: use default if provided, otherwise first available
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>(defaultRepositoryId);

  // Reset selection and tab when dialog opens or default changes
  useEffect(() => {
    if (open) {
      setSelectedRepoId(defaultRepositoryId);
      setActiveTab('worktree');
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

  // Quick Start session mutation
  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.root() });
      onOpenChange(false);
      navigate({ to: `/sessions/${data.session.id}` });
    },
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

  const handleStartSession = async (data: CreateQuickSessionRequest) => {
    await createSessionMutation.mutateAsync(data);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) clearError();
    onOpenChange(nextOpen);
  };

  const showRepoSelector = repositories.length > 1 || !defaultRepositoryId;

  const repoSelector = showRepoSelector && repositories.length > 0 ? (
    <div className="flex items-center gap-2 min-w-[120px] flex-1">
      <label htmlFor="repo-selector" className="text-sm text-gray-400 shrink-0">Repo:</label>
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
  ) : undefined;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[calc(100vh-6rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{TABS[activeTab]}</DialogTitle>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex border-b border-slate-700 mb-4 overflow-x-auto">
          {(Object.entries(TABS) as [TabId, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`px-4 py-2 text-sm whitespace-nowrap ${
                activeTab === id
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-slate-400 hover:text-white'
              }`}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <p className="text-sm text-red-400 mb-2" role="alert">{error}</p>
        )}

        {/* Worktree tab */}
        {activeTab === 'worktree' && (
          repositoriesQuery.isLoading || !effectiveRepoId || isLoading ? (
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
              hideTitle
              headerSlot={repoSelector}
            />
          )
        )}

        {/* Quick Start tab */}
        {activeTab === 'quickstart' && (
          <QuickSessionForm
            isPending={createSessionMutation.isPending}
            onSubmit={handleStartSession}
            onCancel={() => handleOpenChange(false)}
          />
        )}

        {/* From Issue tab */}
        {activeTab === 'fromissue' && (
          repositoriesQuery.isLoading || !effectiveRepoId || isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : (
            <FromIssueTab
              repositoryId={effectiveRepoId}
              defaultBranch={defaultBranch}
              defaultAgentId={defaultAgentId}
              onSubmit={handleSubmit}
              onCancel={() => handleOpenChange(false)}
              headerSlot={repoSelector}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
