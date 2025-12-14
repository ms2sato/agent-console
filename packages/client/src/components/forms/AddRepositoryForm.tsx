import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { FormField, Input } from '../ui/FormField';
import { FormOverlay } from '../ui/Spinner';
import type { CreateRepositoryRequest } from '@agent-console/shared';
import { CreateRepositoryRequestSchema } from '@agent-console/shared';

export interface AddRepositoryFormProps {
  isPending: boolean;
  onSubmit: (data: CreateRepositoryRequest) => Promise<void>;
  onCancel: () => void;
}

export function AddRepositoryForm({
  isPending,
  onSubmit,
  onCancel,
}: AddRepositoryFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<CreateRepositoryRequest>({
    resolver: valibotResolver(CreateRepositoryRequestSchema),
    defaultValues: { path: '' },
    mode: 'onBlur',
  });

  const handleFormSubmit = async (data: CreateRepositoryRequest) => {
    try {
      await onSubmit(data);
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Failed to register repository',
      });
    }
  };

  return (
    <div className="relative card mb-5">
      <FormOverlay isVisible={isPending} message="Adding repository..." />
      <h2 className="mb-3 text-lg font-medium">Add Repository</h2>
      <form onSubmit={handleSubmit(handleFormSubmit)}>
        <fieldset disabled={isPending} className="flex gap-3 items-start">
          <div className="flex-1">
            <FormField error={errors.path}>
              <Input
                {...register('path')}
                placeholder="Repository path (e.g., /path/to/repo)"
                error={errors.path}
              />
            </FormField>
            {errors.root && (
              <p className="text-sm text-red-400 mt-1" role="alert">{errors.root.message}</p>
            )}
          </div>
          <button
            type="submit"
            className="btn btn-primary"
          >
            Add
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-danger"
          >
            Cancel
          </button>
        </fieldset>
      </form>
    </div>
  );
}
