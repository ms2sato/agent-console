import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { FormField, Input } from '../ui/FormField';
import { AgentSelector } from '../AgentSelector';
import { FormOverlay } from '../ui/Spinner';
import type { CreateQuickSessionRequest } from '@agent-console/shared';
import { CreateQuickSessionRequestSchema } from '@agent-console/shared';

export interface QuickSessionFormProps {
  isPending: boolean;
  onSubmit: (data: CreateQuickSessionRequest) => Promise<void>;
  onCancel: () => void;
}

export function QuickSessionForm({
  isPending,
  onSubmit,
  onCancel,
}: QuickSessionFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateQuickSessionRequest>({
    resolver: valibotResolver(CreateQuickSessionRequestSchema),
    defaultValues: {
      type: 'quick',
      locationPath: '/tmp',
      agentId: undefined,
    },
    mode: 'onBlur',
  });

  const handleFormSubmit = async (data: CreateQuickSessionRequest) => {
    try {
      await onSubmit(data);
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Failed to start session',
      });
    }
  };

  return (
    <div className="relative card mb-4 bg-slate-800">
      <FormOverlay isVisible={isPending} message="Starting session..." />
      <h3 className="text-sm font-medium mb-3">Start Session in Any Directory</h3>
      <form onSubmit={handleSubmit(handleFormSubmit)}>
        <input type="hidden" {...register('type')} value="quick" />
        <fieldset disabled={isPending} className="flex flex-col gap-3">
          <FormField error={errors.locationPath}>
            <Input
              {...register('locationPath')}
              placeholder="Path (e.g., /path/to/project)"
              autoFocus
              error={errors.locationPath}
            />
          </FormField>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Agent:</span>
            <AgentSelector
              value={watch('agentId')}
              onChange={(value) => {
                setValue('agentId', value);
              }}
              className="flex-1"
            />
          </div>
          {errors.root && (
            <p className="text-sm text-red-400" role="alert">{errors.root.message}</p>
          )}
          <div className="flex gap-3">
            <button
              type="submit"
              className="btn btn-primary text-sm"
            >
              Start
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
