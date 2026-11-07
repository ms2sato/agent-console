import { buildReceiveUrl } from '../../lib/inbound-webhook-form';
import { CopyButton } from './CopyButton';
import { useInternetOrigin } from './hooks/useInboundWebhookEndpoints';

export const RECEIVE_URL_UNSET_HINT = 'Set AGENT_CONSOLE_INTERNET_ORIGIN on the server to show the full URL';

/**
 * The URL a sender posts to: `<internetOrigin>/webhooks/in/<id>`. When the
 * server setting is unset only the path is shown, with a hint, and Copy copies
 * the path. The endpoint resources carry no origin; it comes from the health read.
 */
export function ReceiveUrl({ endpointId }: { endpointId: string }) {
  const { internetOrigin, isLoaded } = useInternetOrigin();
  const receive = buildReceiveUrl(internetOrigin, endpointId);

  return (
    <div data-testid="receive-url" className="text-sm text-gray-500">
      <div className="flex items-center gap-2">
        <span>Receive URL:</span>
        <code className="min-w-0 break-all text-gray-300">{receive.url}</code>
        <CopyButton text={receive.url} />
      </div>
      {isLoaded && !receive.hasOrigin && <div className="text-yellow-300">{RECEIVE_URL_UNSET_HINT}</div>}
    </div>
  );
}
