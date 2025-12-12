import { useState, useCallback } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
} from './alert-dialog';

export interface ErrorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  message: string;
  actionLabel?: string;
}

/**
 * A dialog component for displaying error messages.
 * Use this to replace native alert() calls with a consistent UI.
 */
export function ErrorDialog({
  open,
  onOpenChange,
  title = 'Error',
  message,
  actionLabel = 'OK',
}: ErrorDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-400">{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>{actionLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface ErrorDialogState {
  open: boolean;
  title: string;
  message: string;
}

/**
 * Hook to manage error dialog state.
 * Returns state and handlers for the ErrorDialog component.
 *
 * @example
 * const { errorDialogProps, showError } = useErrorDialog();
 *
 * // Show error
 * showError('Something went wrong');
 * showError('Custom title', 'Error message');
 *
 * // Render dialog
 * <ErrorDialog {...errorDialogProps} />
 */
export function useErrorDialog() {
  const [state, setState] = useState<ErrorDialogState>({
    open: false,
    title: 'Error',
    message: '',
  });

  const showError = useCallback((titleOrMessage: string, message?: string) => {
    if (message !== undefined) {
      setState({
        open: true,
        title: titleOrMessage,
        message,
      });
    } else {
      setState({
        open: true,
        title: 'Error',
        message: titleOrMessage,
      });
    }
  }, []);

  const hideError = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  return {
    errorDialogProps: {
      open: state.open,
      title: state.title,
      message: state.message,
      onOpenChange: (open: boolean) => {
        if (!open) hideError();
      },
    },
    showError,
    hideError,
  };
}
