import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import type { Repository } from '@agent-console/shared';
import { updateRepository, type UpdateRepositoryRequest } from '../../lib/api';
import { FormField, Textarea } from '../ui/FormField';
import { FormOverlay } from '../ui/Spinner';

// Form data schema - setup command and env vars are optional, can be empty
const EditRepositoryFormSchema = v.object({
  setupCommand: v.optional(
    v.pipe(
      v.string(),
      v.trim()
    )
  ),
  envVars: v.optional(
    v.pipe(
      v.string(),
      v.trim()
    )
  ),
});

type EditRepositoryFormData = v.InferOutput<typeof EditRepositoryFormSchema>;

export interface EditRepositoryFormProps {
  repository: Repository & { setupCommand?: string | null; envVars?: string | null };
  onSuccess: () => void;
  onCancel: () => void;
}

export function EditRepositoryForm({ repository, onSuccess, onCancel }: EditRepositoryFormProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EditRepositoryFormData>({
    resolver: valibotResolver(EditRepositoryFormSchema),
    defaultValues: {
      setupCommand: repository.setupCommand ?? '',
      envVars: repository.envVars ?? '',
    },
    mode: 'onBlur',
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateRepositoryRequest) => updateRepository(repository.id, data),
    onMutate: async (data) => {
      // Cancel any outgoing refetches to prevent overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: ['repositories'] });

      // Snapshot the previous value for rollback
      const previousRepositories = queryClient.getQueryData<{ repositories: Repository[] }>(['repositories']);

      // Optimistically update the cache
      queryClient.setQueryData<{ repositories: Repository[] } | undefined>(['repositories'], (old) => {
        if (!old) return old;
        return {
          repositories: old.repositories.map((r) =>
            r.id === repository.id ? { ...r, setupCommand: data.setupCommand, envVars: data.envVars } : r
          ),
        };
      });

      return { previousRepositories };
    },
    onSuccess: () => {
      // Server WebSocket broadcast will handle cache update, but call onSuccess callback
      onSuccess();
    },
    onError: (err, _data, context) => {
      // Rollback to previous value on error
      if (context?.previousRepositories) {
        queryClient.setQueryData(['repositories'], context.previousRepositories);
      }
      setError(err instanceof Error ? err.message : 'Failed to update repository');
    },
  });

  const handleFormSubmit = (data: EditRepositoryFormData) => {
    setError(null);
    // Send empty string as-is; server will convert to null for database storage
    updateMutation.mutate({
      setupCommand: data.setupCommand?.trim() ?? '',
      envVars: data.envVars?.trim() ?? '',
    });
  };

  return (
    <div className="relative card mb-4">
      <FormOverlay isVisible={updateMutation.isPending} message="Saving changes..." />
      <h3 className="text-lg font-medium mb-2">{repository.name}</h3>
      <p className="text-sm text-gray-500 mb-4 font-mono">{repository.path}</p>

      <form onSubmit={handleSubmit(handleFormSubmit)}>
        <fieldset disabled={updateMutation.isPending} className="flex flex-col gap-4">
          <FormField label="Setup Command (optional)" error={errors.setupCommand}>
            <Textarea
              {...register('setupCommand')}
              placeholder="e.g., bun install && bun run build"
              rows={3}
              className="font-mono text-sm"
              error={errors.setupCommand}
            />
            <p className="text-xs text-gray-500 mt-1">
              This command runs automatically after creating a new worktree. Available template variables:
            </p>
            <ul className="text-xs text-gray-500 mt-1 ml-4 list-disc">
              <li><code className="bg-slate-700 px-1 rounded">{'{{WORKTREE_NUM}}'}</code> - Worktree number (e.g., "3")</li>
              <li><code className="bg-slate-700 px-1 rounded">{'{{BRANCH}}'}</code> - Branch name</li>
              <li><code className="bg-slate-700 px-1 rounded">{'{{REPO}}'}</code> - Repository name</li>
              <li><code className="bg-slate-700 px-1 rounded">{'{{WORKTREE_PATH}}'}</code> - Full path to the worktree</li>
            </ul>
          </FormField>

          <FormField label="Environment Variables (optional)" error={errors.envVars}>
            <Textarea
              {...register('envVars')}
              placeholder={"# .env format\nAPI_KEY=your_api_key\nDEBUG=true"}
              rows={5}
              className="font-mono text-sm"
              error={errors.envVars}
            />
            <p className="text-xs text-gray-500 mt-1">
              Set environment variables for all workers in this repository. Use .env format (KEY=value, one per line).
            </p>
          </FormField>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm">
              Save Changes
            </button>
            <button type="button" onClick={onCancel} className="btn btn-danger text-sm">
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
