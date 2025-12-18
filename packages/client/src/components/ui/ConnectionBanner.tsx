import { Spinner } from './Spinner';

interface ConnectionBannerProps {
  connected: boolean;
}

/**
 * Banner that shows when WebSocket connection is lost.
 * Displays a warning message that real-time updates are disconnected.
 */
export function ConnectionBanner({ connected }: ConnectionBannerProps) {
  if (connected) {
    return null;
  }

  return (
    <div className="bg-amber-600/90 text-white px-4 py-2 text-sm flex items-center justify-center gap-2">
      <Spinner size="sm" />
      <span>Real-time updates disconnected. Reconnecting...</span>
    </div>
  );
}
