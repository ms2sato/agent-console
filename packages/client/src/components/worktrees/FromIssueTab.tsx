import { useState, useRef } from 'react';
import { FormField, Input } from '../ui/FormField';
import { AgentSelector, useResolvedAgentId } from '../AgentSelector';
import { Spinner } from '../ui/Spinner';
import { fetchGitHubIssue } from '../../lib/api';
import type { GitHubIssueSummary } from '@agent-console/shared';
import type { CreateWorktreeFormRequest } from './CreateWorktreeForm';

export interface FromIssueTabProps {
  repositoryId: string;
  defaultAgentId?: string | null;
  onSubmit: (request: CreateWorktreeFormRequest) => Promise<void>;
  onCancel: () => void;
}

export function FromIssueTab({
  repositoryId,
  defaultAgentId,
  onSubmit,
  onCancel,
}: FromIssueTabProps) {
  const [issueReference, setIssueReference] = useState('');
  const [agentId, setAgentId] = useState<string | undefined>(defaultAgentId ?? undefined);
  const resolvedAgentId = useResolvedAgentId(agentId, defaultAgentId ?? undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [issue, setIssue] = useState<GitHubIssueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  const handleCreate = async () => {
    if (!issue) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const initialPrompt = issue.body.trim() || issue.title;
      await onSubmit({
        mode: 'prompt',
        initialPrompt,
        title: issue.title,
        autoStartSession: true,
        agentId: resolvedAgentId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree');
    } finally {
      setIsSubmitting(false);
    }
  };

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

      {issue && (
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
          <p className="mt-2 whitespace-pre-wrap text-xs text-gray-400 max-h-40 overflow-auto">
            {issue.body || 'No description provided.'}
          </p>
          {issue.suggestedBranch && (
            <p className="mt-2 text-xs text-gray-500">
              Suggested branch: {issue.suggestedBranch}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-400">Agent:</span>
        <AgentSelector
          value={resolvedAgentId}
          onChange={setAgentId}
          priorityAgentId={defaultAgentId ?? undefined}
        />
      </div>

      {error && (
        <p className="text-sm text-red-400" role="alert">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-danger text-sm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={!issue || isSubmitting}
          className="btn btn-primary text-sm"
        >
          {isSubmitting ? <Spinner size="sm" /> : 'Create & Start Session'}
        </button>
      </div>
    </div>
  );
}
