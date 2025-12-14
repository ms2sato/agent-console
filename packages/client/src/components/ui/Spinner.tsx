import { type ComponentProps } from 'react';

export type SpinnerSize = 'sm' | 'md' | 'lg';

interface SpinnerProps extends Omit<ComponentProps<'div'>, 'children'> {
  size?: SpinnerSize;
}

const sizeClasses: Record<SpinnerSize, string> = {
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
  lg: 'w-8 h-8 border-3',
};

export function Spinner({ size = 'md', className = '', ...props }: SpinnerProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`inline-block rounded-full border-current border-r-transparent animate-spin ${sizeClasses[size]} ${className}`}
      {...props}
    />
  );
}

interface LoadingOverlayProps {
  message?: string;
}

export function LoadingOverlay({ message = 'Loading...' }: LoadingOverlayProps) {
  return (
    <div className="fixed inset-0 bg-slate-900/80 flex flex-col items-center justify-center z-50">
      <Spinner size="lg" className="text-indigo-500" />
      <p className="mt-4 text-gray-300">{message}</p>
    </div>
  );
}

interface ButtonSpinnerProps {
  isPending: boolean;
  pendingText: string;
  children: React.ReactNode;
}

export function ButtonSpinner({ isPending, pendingText, children }: ButtonSpinnerProps) {
  if (!isPending) {
    return <>{children}</>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Spinner size="sm" />
      {pendingText}
    </span>
  );
}

interface FormOverlayProps {
  isVisible: boolean;
  message?: string;
}

/**
 * An overlay that covers a form container during loading.
 * The parent element must have `position: relative` set.
 */
export function FormOverlay({ isVisible, message }: FormOverlayProps) {
  if (!isVisible) {
    return null;
  }

  return (
    <div className="absolute inset-0 bg-slate-900/70 rounded flex flex-col items-center justify-center z-10">
      <Spinner size="md" className="text-indigo-500" />
      {message && <p className="mt-3 text-sm text-gray-300">{message}</p>}
    </div>
  );
}
