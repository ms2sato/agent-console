import { Link } from '@tanstack/react-router';
import { PageBreadcrumb } from './PageBreadcrumb';

interface PageErrorFallbackProps {
  error: Error;
  reset: () => void;
  breadcrumbItems: Array<{ label: string; to?: string; params?: Record<string, string> }>;
  errorMessage: string;
  backTo: string;
  backLabel: string;
}

export function PageErrorFallback({
  error,
  reset,
  breadcrumbItems,
  errorMessage,
  backTo,
  backLabel,
}: PageErrorFallbackProps) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={breadcrumbItems} />
      <div className="card text-center py-10">
        <p className="text-red-400 mb-2">{errorMessage}</p>
        <p className="text-gray-500 text-sm mb-4">{error.message}</p>
        <div className="flex justify-center gap-2">
          <button onClick={reset} className="btn btn-secondary">
            Retry
          </button>
          <Link to={backTo as string} className="btn btn-primary">
            {backLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
