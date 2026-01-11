import { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import type { Repository } from '@agent-console/shared';
import {
  updateRepository,
  type UpdateRepositoryRequest,
  fetchRepositorySlackIntegration,
  updateRepositorySlackIntegration,
  testRepositorySlackIntegration,
  fetchNotificationStatus,
} from '../../lib/api';
import { FormField, Input, Textarea } from '../ui/FormField';
import { FormOverlay, Spinner } from '../ui/Spinner';

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

// Slack settings form schema
const SlackSettingsFormSchema = v.object({
  webhookUrl: v.pipe(
    v.string(),
    v.trim()
    // Note: Full validation (minLength + regex) is optional here since empty URL is valid (disables integration)
  ),
  enabled: v.boolean(),
});

type SlackSettingsFormData = v.InferOutput<typeof SlackSettingsFormSchema>;

// Slack settings section component
interface SlackSettingsSectionProps {
  repositoryId: string;
}

function SlackSettingsSection({ repositoryId }: SlackSettingsSectionProps) {
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup timer on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Fetch existing Slack integration settings
  const { data: existingIntegration, isLoading } = useQuery({
    queryKey: ['repository-slack-integration', repositoryId],
    queryFn: () => fetchRepositorySlackIntegration(repositoryId),
  });

  // Fetch notification status to check if APP_URL is configured
  const { data: notificationStatus } = useQuery({
    queryKey: ['notification-status'],
    queryFn: fetchNotificationStatus,
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
    reset,
  } = useForm<SlackSettingsFormData>({
    resolver: valibotResolver(SlackSettingsFormSchema),
    defaultValues: {
      webhookUrl: '',
      enabled: false, // Default to disabled until webhook URL is configured
    },
    values: existingIntegration
      ? { webhookUrl: existingIntegration.webhookUrl, enabled: existingIntegration.enabled }
      : undefined,
    mode: 'onBlur',
  });

  const watchedWebhookUrl = watch('webhookUrl');
  const isWebhookUrlValid = watchedWebhookUrl.startsWith('https://hooks.slack.com/');

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (data: SlackSettingsFormData) =>
      updateRepositorySlackIntegration(repositoryId, {
        webhookUrl: data.webhookUrl,
        enabled: data.enabled,
      }),
    onSuccess: (result) => {
      setSaveError(null);
      // Reset form state to mark as not dirty after successful save
      reset({ webhookUrl: result.webhookUrl, enabled: result.enabled });
    },
    onError: (err) => {
      setSaveError(err instanceof Error ? err.message : 'Failed to save Slack settings');
    },
  });

  // Test notification mutation
  const testMutation = useMutation({
    mutationFn: () => testRepositorySlackIntegration(repositoryId),
    onMutate: () => {
      // Clear any existing timer before starting a new test
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setTestStatus('sending');
      setTestError(null);
    },
    onSuccess: () => {
      setTestStatus('success');
      // Reset to idle after 3 seconds
      timerRef.current = setTimeout(() => setTestStatus('idle'), 3000);
    },
    onError: (err) => {
      setTestStatus('error');
      setTestError(err instanceof Error ? err.message : 'Failed to send test notification');
      // Reset to idle after 5 seconds
      timerRef.current = setTimeout(() => setTestStatus('idle'), 5000);
    },
  });

  const handleSaveSlackSettings = (data: SlackSettingsFormData) => {
    setSaveError(null);
    saveMutation.mutate(data);
  };

  const handleTestNotification = () => {
    testMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="mt-6 pt-6 border-t border-slate-700">
        <h4 className="text-md font-medium mb-4">Slack Notifications</h4>
        <div className="flex items-center gap-2 text-gray-400">
          <Spinner size="sm" />
          <span>Loading Slack settings...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6 pt-6 border-t border-slate-700">
      <h4 className="text-md font-medium mb-4">Slack Notifications</h4>

      {notificationStatus && !notificationStatus.isBaseUrlConfigured && (
        <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-600 rounded text-yellow-200 text-sm">
          <strong>Warning:</strong> APP_URL environment variable is not set.
          The "Open Session" button in Slack notifications will not work correctly.
          Set APP_URL to your Agent Console URL (e.g., APP_URL=http://localhost:5173).
        </div>
      )}

      <form onSubmit={handleSubmit(handleSaveSlackSettings)}>
        <fieldset disabled={saveMutation.isPending} className="flex flex-col gap-4">
          <FormField label="Webhook URL" error={errors.webhookUrl}>
            <Input
              {...register('webhookUrl')}
              type="url"
              placeholder="https://hooks.slack.com/services/..."
              className="font-mono text-sm"
              error={errors.webhookUrl}
            />
            <p className="text-xs text-gray-500 mt-1">
              Enter your Slack Incoming Webhook URL to receive notifications when agent state changes.
            </p>
          </FormField>

          <div className="flex items-center gap-2">
            <input
              {...register('enabled')}
              type="checkbox"
              id="slack-enabled"
              className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-slate-900"
            />
            <label htmlFor="slack-enabled" className="text-sm text-gray-400">
              Enable notifications
            </label>
          </div>

          {saveError && (
            <p className="text-sm text-red-400">{saveError}</p>
          )}

          <div className="flex items-center justify-between">
            <button
              type="submit"
              disabled={!isDirty}
              className="btn btn-primary text-sm disabled:opacity-50"
            >
              {saveMutation.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" />
                  Saving...
                </span>
              ) : (
                'Save Slack Settings'
              )}
            </button>

            <div className="flex items-center gap-2">
              {testStatus === 'success' && (
                <span className="text-sm text-green-400">Sent!</span>
              )}
              {testStatus === 'error' && testError && (
                <span className="text-sm text-red-400" title={testError}>Failed</span>
              )}
              <button
                type="button"
                onClick={handleTestNotification}
                disabled={!isWebhookUrlValid || testStatus === 'sending' || !existingIntegration}
                className="btn btn-secondary text-sm disabled:opacity-50"
                title={!existingIntegration ? 'Save settings first to test' : !isWebhookUrlValid ? 'Enter a valid Slack webhook URL' : 'Send a test notification'}
              >
                {testStatus === 'sending' ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner size="sm" />
                    Sending...
                  </span>
                ) : (
                  'Test'
                )}
              </button>
            </div>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

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

      {/* Slack Notifications Section (separate form) */}
      <SlackSettingsSection repositoryId={repository.id} />
    </div>
  );
}
