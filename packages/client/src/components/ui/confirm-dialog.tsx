import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from './alert-dialog';
import { ButtonSpinner } from './Spinner';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
  isLoading?: boolean;
}

/**
 * A reusable confirmation dialog component.
 * Use this to replace native confirm() calls with a consistent UI.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  isLoading = false,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className={variant === 'danger' ? 'text-red-400' : undefined}>
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel}
          </AlertDialogCancel>
          {variant === 'danger' ? (
            <button
              onClick={onConfirm}
              className="btn btn-danger"
              disabled={isLoading}
            >
              <ButtonSpinner isPending={isLoading} pendingText="Processing...">
                {confirmLabel}
              </ButtonSpinner>
            </button>
          ) : (
            <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
              <ButtonSpinner isPending={isLoading} pendingText="Processing...">
                {confirmLabel}
              </ButtonSpinner>
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Hook to manage confirm dialog state.
 * Returns state and handlers for the ConfirmDialog component.
 */
export function useConfirmDialog() {
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    variant?: 'default' | 'danger';
    onConfirm: () => void;
  }>({
    open: false,
    title: '',
    description: '',
    onConfirm: () => {},
  });

  const showConfirm = (options: {
    title: string;
    description: string;
    confirmLabel?: string;
    variant?: 'default' | 'danger';
    onConfirm: () => void;
  }) => {
    setState({
      open: true,
      ...options,
    });
  };

  const hideConfirm = () => {
    setState(prev => ({ ...prev, open: false }));
  };

  return {
    confirmDialogProps: {
      ...state,
      onOpenChange: (open: boolean) => {
        if (!open) hideConfirm();
      },
    },
    showConfirm,
    hideConfirm,
  };
}
