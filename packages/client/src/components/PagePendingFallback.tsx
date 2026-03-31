import { Spinner } from './ui/Spinner';

interface PagePendingFallbackProps {
  message: string;
}

export function PagePendingFallback({ message }: PagePendingFallbackProps) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-gray-500">
        <Spinner size="sm" />
        <span>{message}</span>
      </div>
    </div>
  );
}
