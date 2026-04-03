import { useState, useRef } from 'react';
import { FormField, Input } from '../ui/FormField';
import { Spinner } from '../ui/Spinner';
import { fetchGitHubIssue } from '../../lib/api';
import type { GitHubIssueSummary } from '@agent-console/shared';
import { CreateWorktreeForm, type CreateWorktreeFormRequest } from './CreateWorktreeForm';
import type { ReactNode } from 'react';

export interface FromIssueTabProps {
  repositoryId: string;
  defaultBranch: string;
  defaultAgentId?: string | null;
  onSubmit: (request: CreateWorktreeFormRequest) => Promise<void>;
  onCancel: () => void;
  /** Repo selector slot (same as Worktree tab) */
  headerSlot?: ReactNode;
}

export function FromIssueTab({
  repositoryId,
  defaultBranch,
  defaultAgentId,
  onSubmit,
  onCancel,
  headerSlot,
}: FromIssueTabProps) {
  const [issueReference, setIssueReference] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [issue, setIssue] = useState<GitHubIssueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastFetchedRef = useRef<string | null>(null);

  const handleFetch = async () => {
    const trimmed = issueReference.trim();
    if (!trimmed) return;
    if (lastFetchedRef.current === trimmed) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchGitHubIssue(repositoryId, trimmed);
      lastFetchedRef.current = trimmed;
      setIssue(result.issue);
    } catch (err) {
      setIssue(null);
      setError(err instanceof Error ? err.message : 'Failed to fetch issue');
    } finally {
      setIsLoading(false);
    }
  };

  // Build the issue preview card + repo selector as header slot for CreateWorktreeForm
  const issueHeaderSlot = issue ? (
    <div className="w-full flex flex-col gap-2">
      {headerSlot}
      <div className="rounded border border-slate-700 bg-slate-900/60 p-3 text-sm text-gray-300">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-gray-200">{issue.title}</p>
          <a
            className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
            href={issue.url}
            target="_blank"
            rel="noreferrer"
          >
            Open on GitHub
          </a>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-xs text-gray-400 max-h-32 overflow-auto">
          {issue.body || 'No description provided.'}
        </p>
      </div>
    </div>
  ) : undefined;

  // Phase 1: Before issue is fetched, show just the fetch form
  if (!issue) {
    return (
      <div className="flex flex-col gap-4">
        <FormField label="Issue URL or reference">
          <div className="flex gap-2">
            <Input
              value={issueReference}
              onChange={(e) => setIssueReference(e.target.value)}
              placeholder="https://github.com/owner/repo/issues/123 or #123"
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleFetch();
                }
              }}
            />
            <button
              type="button"
              className="btn bg-slate-600 hover:bg-slate-500 text-sm shrink-0"
              onClick={handleFetch}
              disabled={isLoading || !issueReference.trim()}
            >
              {isLoading ? <Spinner size="sm" /> : 'Fetch'}
            </button>
          </div>
        </FormField>

        {error && (
          <p className="text-sm text-red-400" role="alert">{error}</p>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-danger text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Phase 2: After issue is fetched, show full CreateWorktreeForm with prefilled values
  const prefillValues = {
    initialPrompt: issue.body.trim() || issue.title,
    sessionTitle: issue.title,
    branchNameMode: 'prompt' as const,
  };

  return (
    <CreateWorktreeForm
      key={`from-issue-${issue.number}`}
      repositoryId={repositoryId}
      defaultBranch={defaultBranch}
      defaultAgentId={defaultAgentId}
      onSubmit={onSubmit}
      onCancel={onCancel}
      hideTitle
      headerSlot={issueHeaderSlot}
      prefillValues={prefillValues}
    />
  );
}
