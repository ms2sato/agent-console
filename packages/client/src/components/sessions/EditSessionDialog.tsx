import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { FormField, Input } from '../ui/FormField';
import { EditSessionFormSchema, type EditSessionFormData } from '../../schemas/edit-session-form';
import { updateSessionMetadata } from '../../lib/api';

export interface EditSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  currentTitle?: string;
  onTitleChange?: (newTitle: string) => void;
}

export function EditSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentTitle,
  onTitleChange,
}: EditSessionDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<EditSessionFormData>({
    resolver: valibotResolver(EditSessionFormSchema),
    defaultValues: {
      title: currentTitle ?? '',
    },
    mode: 'onBlur',
  });

  const titleValue = watch('title');
  const titleChanged = (titleValue?.trim() ?? '') !== (currentTitle ?? '');

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSubmitError(null);
      reset({ title: currentTitle ?? '' });
    }
  }, [open, currentTitle, reset]);

  const handleClose = () => {
    onOpenChange(false);
  };

  const onFormSubmit = async (data: EditSessionFormData) => {
    if (!titleChanged) {
      handleClose();
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const result = await updateSessionMetadata(sessionId, {
        title: data.title?.trim() ?? '',
      });

      if (result.title !== undefined && onTitleChange) {
        onTitleChange(result.title);
      }
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to update session');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Session</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
          <FormField label="Title" error={errors.title}>
            <Input
              {...register('title')}
              error={errors.title}
              className="w-full"
              placeholder="Session title (optional)"
              autoFocus
            />
          </FormField>
          {submitError && <p className="text-sm text-red-400" role="alert">{submitError}</p>}
          <DialogFooter>
            <button
              type="button"
              onClick={handleClose}
              className="btn bg-slate-600 hover:bg-slate-500"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
