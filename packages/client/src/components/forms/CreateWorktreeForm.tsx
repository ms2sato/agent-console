import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { FormField, Input, Textarea } from '../ui/FormField';
import { AgentSelector } from '../AgentSelector';
import type { CreateWorktreeFormData } from '../../schemas/worktree-form';
import { CreateWorktreeFormSchema } from '../../schemas/worktree-form';
import type { CreateWorktreeRequest } from '@agent-console/shared';

export interface CreateWorktreeFormProps {
  defaultBranch: string;
  isPending: boolean;
  onSubmit: (request: CreateWorktreeRequest) => Promise<void>;
  onCancel: () => void;
}

export function CreateWorktreeForm({
  defaultBranch,
  isPending,
  onSubmit,
  onCancel,
}: CreateWorktreeFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateWorktreeFormData>({
    resolver: valibotResolver(CreateWorktreeFormSchema),
    defaultValues: {
      branchNameMode: 'prompt',
      initialPrompt: '',
      customBranch: '',
      baseBranch: '',
      sessionTitle: '',
      agentId: undefined,
    },
    mode: 'onBlur',
  });

  const branchNameMode = watch('branchNameMode');
  const initialPrompt = watch('initialPrompt');

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
    <div className={`bg-slate-800 p-4 rounded mb-4 ${isPending ? 'opacity-70' : ''}`}>
      <h3 className="text-sm font-medium mb-3">
        {isPending ? 'Creating Worktree...' : 'Create Worktree'}
      </h3>
      <form onSubmit={handleSubmit(handleFormSubmit)}>
        <fieldset disabled={isPending} className="flex flex-col gap-3">
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
              {isPending ? 'Creating...' : 'Create & Start Session'}
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
    </div>
  );
}
