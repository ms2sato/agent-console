import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import * as v from 'valibot';
import {
  CloneRepositoryRequestSchema,
  type CloneJobError,
} from '@agent-console/shared';
import { FormField, Input, Textarea } from '../ui/FormField';
import { FormOverlay, Spinner } from '../ui/Spinner';
import { useCloneJobStatus, useCloneRepository } from './hooks/use-clone-repository';
import { formatCloneJobError } from './clone-error-messages';

type CloneFormData = v.InferOutput<typeof CloneRepositoryRequestSchema>;

export interface CloneFromUrlFormProps {
  /**
   * Called once the Clone Job reaches `succeeded`. Receives the
   * registered repository's id so the parent can close the dialog and
   * navigate to the repository's detail view.
   */
  onSuccess: (repositoryId: string) => void;
  onCancel: () => void;
}

export function CloneFromUrlForm({ onSuccess, onCancel }: CloneFromUrlFormProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const cloneMutation = useCloneRepository();
  const statusQuery = useCloneJobStatus(jobId);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CloneFormData>({
    resolver: valibotResolver(CloneRepositoryRequestSchema),
    defaultValues: {
      url: '',
      // `name` is omitted (undefined). The shared schema's optional name
      // requires `minLength(1)` once present, so we keep it absent until
      // the user types something. The input's `setValueAs` further
      // converts whitespace-only input to `undefined` to round-trip safely.
      description: '',
    },
    mode: 'onBlur',
  });

  // Once the polling query reports terminal success, lift the
  // repositoryId up to the parent. The query stops polling itself on
  // terminal status (`refetchInterval: () => false`), so this `useEffect`
  // fires at most once per Clone Job.
  const status = statusQuery.data;
  const succeededRepositoryId =
    status?.status === 'succeeded' ? status.repositoryId : undefined;
  useEffect(() => {
    if (succeededRepositoryId) {
      onSuccess(succeededRepositoryId);
    }
  }, [succeededRepositoryId, onSuccess]);

  const isPolling = jobId !== null && status?.status !== 'succeeded' && status?.status !== 'failed';
  const isPending = cloneMutation.isPending || isPolling;

  const failureError: CloneJobError | undefined =
    status?.status === 'failed' ? status.error : undefined;
  const failureMessage = failureError ? formatCloneJobError(failureError) : null;

  const handleFormSubmit = async (data: CloneFormData) => {
    setSubmitError(null);
    try {
      // Strip empty optional fields so the server sees `undefined`
      // rather than `""` (the server's validator will accept either,
      // but keeping payload minimal is courteous and matches the spec).
      const payload = {
        url: data.url,
        ...(data.name ? { name: data.name } : {}),
        ...(data.description ? { description: data.description } : {}),
      };
      const result = await cloneMutation.mutateAsync(payload);
      setJobId(result.jobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start clone');
    }
  };

  const overlayMessage = cloneMutation.isPending
    ? 'Starting clone...'
    : status?.status === 'cloning'
      ? 'Cloning...'
      : status?.status === 'pending'
        ? 'Waiting to start...'
        : 'Working...';

  return (
    <div className="relative">
      <FormOverlay isVisible={isPending} message={overlayMessage} />
      <form onSubmit={handleSubmit(handleFormSubmit)}>
        <fieldset disabled={isPending} className="flex flex-col gap-4">
          <FormField label="Repository URL" error={errors.url}>
            <Input
              {...register('url')}
              placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
              error={errors.url}
            />
            <p className="text-xs text-gray-500 mt-1">
              The server clones into the shared source-repos directory using your SSH or HTTPS credentials.
            </p>
          </FormField>

          <FormField label="Name (optional)" error={errors.name}>
            <Input
              {...register('name', {
                // Shared schema rejects empty-string name (it requires
                // `minLength(1)` once the optional field is present).
                // Convert blank input to `undefined` so the field is
                // simply absent rather than failing validation.
                setValueAs: (value: string) =>
                  typeof value === 'string' && value.trim() === '' ? undefined : value,
              })}
              placeholder="Leave blank to use the URL's last segment"
              error={errors.name}
            />
          </FormField>

          <FormField label="Description (optional)" error={errors.description}>
            <Textarea
              {...register('description')}
              placeholder="Brief description of the repository"
              rows={3}
              className="text-sm"
              error={errors.description}
            />
          </FormField>

          {submitError && (
            <p className="text-sm text-red-400" role="alert">{submitError}</p>
          )}

          {failureMessage && (
            <div className="rounded border border-red-700 bg-red-900/30 p-3" role="alert">
              <p className="text-sm text-red-200">{failureMessage}</p>
              {failureError?.code !== 'unknown' && failureError?.message && (
                <p className="mt-1 text-xs text-red-300 font-mono break-all">
                  {failureError.message}
                </p>
              )}
            </div>
          )}

          {isPolling && (
            <div className="inline-flex items-center gap-2 text-sm text-gray-300">
              <Spinner size="sm" />
              <span>{overlayMessage}</span>
            </div>
          )}

          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary">
              Clone &amp; Register
            </button>
            <button type="button" onClick={onCancel} className="btn btn-danger">
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
