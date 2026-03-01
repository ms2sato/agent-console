import { Spinner } from './Spinner';

interface ConnectionBannerProps {
  connected: boolean;
  hasEverConnected: boolean;
}

/**
 * Banner that shows when WebSocket connection is lost after a previous connection.
 * Does not show on initial page load before the first connection is established,
 * to avoid a confusing "Reconnecting..." flash.
 */
export function ConnectionBanner({ connected, hasEverConnected }: ConnectionBannerProps) {
  // Don't show banner if currently connected
  if (connected) {
    return null;
  }

  // Don't show banner on initial load before first connection
  if (!hasEverConnected) {
    return null;
  }

  return (
    <div className="bg-amber-600/90 text-white px-4 py-2 text-sm flex items-center justify-center gap-2">
      <Spinner size="sm" />
      <span>Real-time updates disconnected. Reconnecting...</span>
    </div>
  );
}
