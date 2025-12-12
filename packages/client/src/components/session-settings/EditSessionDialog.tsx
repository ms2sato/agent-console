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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../ui/alert-dialog';
import { FormField, Input } from '../ui/FormField';
import { EditSessionFormSchema, type EditSessionFormData } from '../../schemas/edit-session-form';
import { updateSessionMetadata } from '../../lib/api';

export interface EditSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  currentBranch: string;
  currentTitle?: string;
  onBranchChange: (newBranch: string) => void;
  onTitleChange?: (newTitle: string) => void;
  onSessionRestart?: () => void;
}

type DialogMode = 'edit' | 'confirm-restart';

export function EditSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentBranch,
  currentTitle,
  onBranchChange,
  onTitleChange,
  onSessionRestart,
}: EditSessionDialogProps) {
  const [mode, setMode] = useState<DialogMode>('edit');
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
      branch: currentBranch,
    },
    mode: 'onBlur',
  });

  const branchValue = watch('branch');
  const titleValue = watch('title');

  const branchChanged = branchValue?.trim() !== currentBranch;
  const titleChanged = (titleValue?.trim() ?? '') !== (currentTitle ?? '');

  // Sync with current values when they change externally
  useEffect(() => {
    reset({
      title: currentTitle ?? '',
      branch: currentBranch,
    });
  }, [currentBranch, currentTitle, reset]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setMode('edit');
      setSubmitError(null);
      reset({
        title: currentTitle ?? '',
        branch: currentBranch,
      });
    }
  }, [open, currentBranch, currentTitle, reset]);

  const handleClose = () => {
    onOpenChange(false);
  };

  const onFormSubmit = (data: EditSessionFormData) => {
    // If no changes, just close
    if (!branchChanged && !titleChanged) {
      handleClose();
      return;
    }

    // If branch changed, show confirmation dialog
    if (branchChanged) {
      setMode('confirm-restart');
      return;
    }

    // Only title changed - save directly
    handleSave(data);
  };

  const handleSave = async (data: EditSessionFormData) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const updates: { title?: string; branch?: string } = {};

      if (titleChanged) {
        updates.title = data.title?.trim() ?? '';
      }
      if (branchChanged) {
        updates.branch = data.branch;
      }

      const result = await updateSessionMetadata(sessionId, updates);

      if (result.title !== undefined && onTitleChange) {
        onTitleChange(result.title);
      }
      if (result.branch) {
        onBranchChange(result.branch);
      }
      onOpenChange(false);

      // Notify parent that session was restarted (server does this automatically when branch changes)
      if (branchChanged && onSessionRestart) {
        onSessionRestart();
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to update session');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmRestart = () => {
    // Get current form values and save
    const data: EditSessionFormData = {
      title: titleValue?.trim(),
      branch: branchValue?.trim() ?? currentBranch,
    };
    handleSave(data);
  };

  if (mode === 'confirm-restart') {
    return (
      <AlertDialog open={open} onOpenChange={() => setMode('edit')}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Required</AlertDialogTitle>
            <AlertDialogDescription>
              Branch name change requires restarting the agent. Do you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {submitError && <p className="text-sm text-red-400" role="alert">{submitError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRestart} disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Restart & Save'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

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
          <FormField label="Branch Name" error={errors.branch}>
            <Input
              {...register('branch')}
              error={errors.branch}
              className="w-full"
              placeholder="Enter branch name"
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
