import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSystemHealth } from '../../lib/api';
import { WarningIcon, CloseIcon } from '../Icons';

const DISMISS_KEY = 'webhook-config-banner-dismissed';

/**
 * Banner that warns users when webhook secret is not configured.
 * This prevents webhook events from being processed.
 *
 * The banner can be dismissed, and the dismissal state is persisted
 * in localStorage. Users can see this warning again by clearing localStorage.
 */
export function WebhookConfigBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const { data: health } = useQuery({
    queryKey: ['system', 'health'],
    queryFn: fetchSystemHealth,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Don't render if:
  // - Still loading (health is undefined)
  // - Webhook secret is configured
  // - User dismissed the banner
  if (!health || health.webhookSecretConfigured || dismissed) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, 'true');
    } catch {
      // localStorage might be unavailable
    }
  };

  return (
    <div className="bg-amber-600/20 border-b border-amber-600/30 px-4 py-2 text-sm flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-amber-400">
        <WarningIcon className="w-4 h-4 shrink-0" />
        <span>
          GitHub webhook secret not configured. External webhook events will not be processed.
          {' '}
          <a
            href="https://github.com/ms2sato/agent-console#inbound-integration"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-amber-300"
          >
            Learn how to configure
          </a>
        </span>
      </div>
      <button
        onClick={handleDismiss}
        className="text-amber-400 hover:text-amber-300 p-1 shrink-0"
        aria-label="Dismiss warning"
      >
        <CloseIcon className="w-4 h-4" />
      </button>
    </div>
  );
}
