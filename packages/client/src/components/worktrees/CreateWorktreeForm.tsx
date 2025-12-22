import { useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { FormField, Input, Textarea } from '../ui/FormField';
import { AgentSelector } from '../AgentSelector';
import { FormOverlay } from '../ui/Spinner';
import type { CreateWorktreeFormData } from '../../schemas/worktree-form';
import { CreateWorktreeFormSchema } from '../../schemas/worktree-form';
import type { CreateWorktreeRequest, GitHubIssueSummary } from '@agent-console/shared';
import { fetchGitHubIssue } from '../../lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

export interface CreateWorktreeFormProps {
  repositoryId: string;
  defaultBranch: string;
  isPending: boolean;
  onSubmit: (request: CreateWorktreeRequest) => Promise<void>;
  onCancel: () => void;
}

export function CreateWorktreeForm({
  repositoryId,
  defaultBranch,
  isPending,
  onSubmit,
  onCancel,
}: CreateWorktreeFormProps) {
  const {
    register,
    handleSubmit,
    getValues,
    setError,
    clearErrors,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateWorktreeFormData>({
    resolver: valibotResolver(CreateWorktreeFormSchema),
    defaultValues: {
      branchNameMode: 'prompt',
      initialPrompt: '',
      githubIssue: '',
      customBranch: '',
      baseBranch: '',
      sessionTitle: '',
      agentId: undefined,
    },
    mode: 'onBlur',
    shouldUnregister: true,
  });

  const branchNameMode = watch('branchNameMode');
  const initialPrompt = watch('initialPrompt');
  const issueFieldId = useId();
  const issueErrorId = `${issueFieldId}-error`;
  const lastFetchedIssue = useRef<string | null>(null);
  const [isIssueDialogOpen, setIsIssueDialogOpen] = useState(false);
  const [issueState, setIssueState] = useState<{
    isLoading: boolean;
    issue: GitHubIssueSummary | null;
  }>({ isLoading: false, issue: null });

  const buildIssuePrompt = (issue: GitHubIssueSummary) => {
    const body = issue.body.trim();
    return body || issue.title;
  };

  const handleFetchIssue = async (reference: string | undefined, force = false) => {
    const trimmed = reference?.trim() ?? '';
    if (!trimmed) {
      setIssueState({ isLoading: false, issue: null });
      clearErrors('githubIssue');
      lastFetchedIssue.current = null;
      return;
    }

    if (issueState.isLoading || (!force && lastFetchedIssue.current === trimmed)) {
      return;
    }

    setIssueState({ isLoading: true, issue: issueState.issue });
    clearErrors('githubIssue');

    try {
      const { issue } = await fetchGitHubIssue(repositoryId, trimmed);
      lastFetchedIssue.current = trimmed;
      setIssueState({ isLoading: false, issue });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch GitHub issue';
      setIssueState({ isLoading: false, issue: null });
      setError('githubIssue', { message });
    }
  };

  const applyIssueToForm = () => {
    if (!issueState.issue) return;
    setValue('initialPrompt', buildIssuePrompt(issueState.issue), { shouldDirty: true, shouldValidate: true });
    if (!getValues('sessionTitle')?.trim()) {
      setValue('sessionTitle', issueState.issue.title, { shouldDirty: true });
    }
    // Use 'prompt' mode to let LLM generate a unique branch name from the issue content
    setValue('branchNameMode', 'prompt', { shouldDirty: true, shouldValidate: true });
  };

  const handleFormSubmit = async (data: CreateWorktreeFormData) => {
    try {
      let request: CreateWorktreeRequest;

      switch (data.branchNameMode) {
        case 'prompt':
          request = {
            mode: 'prompt',
            initialPrompt: data.initialPrompt!.trim(),
            baseBranch: data.baseBranch?.trim() || undefined,
            autoStartSession: true,
            agentId: data.agentId,
            title: data.sessionTitle?.trim() || undefined,
          };
          break;
        case 'custom':
          request = {
            mode: 'custom',
            branch: data.customBranch!.trim(),
            baseBranch: data.baseBranch?.trim() || undefined,
            autoStartSession: true,
            agentId: data.agentId,
            initialPrompt: data.initialPrompt?.trim() || undefined,
            title: data.sessionTitle?.trim() || undefined,
          };
          break;
        case 'existing':
          request = {
            mode: 'existing',
            branch: data.customBranch!.trim(),
            autoStartSession: true,
            agentId: data.agentId,
            initialPrompt: data.initialPrompt?.trim() || undefined,
            title: data.sessionTitle?.trim() || undefined,
          };
          break;
      }
      await onSubmit(request);
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Failed to create worktree',
      });
    }
  };

  return (
    <div className="relative bg-slate-800 p-4 rounded mb-4">
      <FormOverlay isVisible={isPending} message="Creating worktree..." />
      <h3 className="text-sm font-medium mb-3">Create Worktree</h3>
      <form onSubmit={handleSubmit(handleFormSubmit)}>
        <fieldset disabled={isPending} className="flex flex-col gap-3">
          <div className="flex items-center justify-end">
            <button
              type="button"
              className="btn bg-slate-700 hover:bg-slate-600 text-sm"
              onClick={() => setIsIssueDialogOpen(true)}
            >
              Import from Issue
            </button>
          </div>

          {/* Initial prompt input (available for all modes) */}
          <FormField label="Initial prompt (optional)" error={errors.initialPrompt}>
            <Textarea
              {...register('initialPrompt')}
              placeholder="What do you want to work on? (e.g., 'Add a dark mode toggle to the settings page')"
              className="w-full min-h-[80px] resize-y"
              rows={3}
              error={errors.initialPrompt}
            />
          </FormField>

          {/* Session title input */}
          <FormField label="Title (optional)" error={errors.sessionTitle}>
            <Input
              {...register('sessionTitle')}
              placeholder="Session title"
              className="w-full"
              error={errors.sessionTitle}
            />
            {initialPrompt?.trim() && (
              <p className="text-xs text-gray-500 mt-1">Leave empty to generate from prompt</p>
            )}
          </FormField>

          {/* Branch name mode selection */}
          <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
            <legend className="text-sm text-gray-400 mb-1">Branch name:</legend>
            <label className={`text-sm flex items-center gap-2 ${!initialPrompt?.trim() ? 'text-gray-600' : 'text-gray-400'}`}>
              <input
                {...register('branchNameMode')}
                type="radio"
                value="prompt"
                disabled={!initialPrompt?.trim()}
              />
              Generate from prompt {initialPrompt?.trim() ? '(recommended)' : '(requires prompt)'}
            </label>
            <label className="text-sm text-gray-400 flex items-center gap-2">
              <input
                {...register('branchNameMode')}
                type="radio"
                value="custom"
              />
              Custom name (new branch)
            </label>
            <label className="text-sm text-gray-400 flex items-center gap-2">
              <input
                {...register('branchNameMode')}
                type="radio"
                value="existing"
              />
              Use existing branch
            </label>
          </fieldset>

          {/* Branch name input (only for custom/existing) */}
          {(branchNameMode === 'custom' || branchNameMode === 'existing') && (
            <FormField error={errors.customBranch}>
              <Input
                {...register('customBranch')}
                placeholder={branchNameMode === 'custom' ? 'New branch name' : 'Existing branch name'}
                error={errors.customBranch}
              />
            </FormField>
          )}

          {/* Base branch input (only for new branches) */}
          {branchNameMode !== 'existing' && (
            <FormField error={errors.baseBranch}>
              <Input
                {...register('baseBranch')}
                placeholder={`Base branch (default: ${defaultBranch})`}
                error={errors.baseBranch}
              />
            </FormField>
          )}

          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Agent:</span>
            <AgentSelector
              value={watch('agentId')}
              onChange={(value) => setValue('agentId', value)}
              className="flex-1"
            />
          </div>

          {errors.root && (
            <p className="text-sm text-red-400" role="alert">{errors.root.message}</p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary text-sm"
            >
              Create & Start Session
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="btn btn-danger text-sm"
            >
              Cancel
            </button>
          </div>
        </fieldset>
      </form>

      <Dialog open={isIssueDialogOpen} onOpenChange={setIsIssueDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import from GitHub Issue</DialogTitle>
            <DialogDescription>
              Fetch the issue title and body, then apply them to the prompt and branch fields.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <FormField label="Issue reference" error={errors.githubIssue} fieldId={issueFieldId}>
              <div className="flex gap-2">
                <Input
                  id={issueFieldId}
                  {...register('githubIssue', {
                    onBlur: (event) => handleFetchIssue(event.target.value),
                  })}
                  placeholder="https://github.com/owner/repo/issues/123 or #123"
                  className="flex-1"
                  aria-describedby={errors.githubIssue ? issueErrorId : undefined}
                  error={errors.githubIssue}
                />
                <button
                  type="button"
                  className="btn bg-slate-600 hover:bg-slate-500 text-sm"
                  onClick={() => handleFetchIssue(getValues('githubIssue'), true)}
                  disabled={issueState.isLoading}
                >
                  {issueState.isLoading ? 'Fetching...' : 'Fetch'}
                </button>
              </div>
            </FormField>

            {issueState.issue && (
              <div className="rounded border border-slate-700 bg-slate-900/60 p-3 text-sm text-gray-300">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-gray-200">{issueState.issue.title}</p>
                  <a
                    className="text-xs text-blue-400 hover:text-blue-300"
                    href={issueState.issue.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open on GitHub
                  </a>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-xs text-gray-400 max-h-40 overflow-auto">
                  {issueState.issue.body || 'No description provided.'}
                </p>
                {issueState.issue.suggestedBranch && (
                  <p className="mt-2 text-xs text-gray-500">
                    Suggested branch: {issueState.issue.suggestedBranch}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              className="btn btn-primary text-sm"
              onClick={() => {
                applyIssueToForm();
                setIsIssueDialogOpen(false);
              }}
              disabled={!issueState.issue}
            >
              Apply
            </button>
            <button
              type="button"
              className="btn btn-danger text-sm"
              onClick={() => setIsIssueDialogOpen(false)}
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
