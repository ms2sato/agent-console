import { Link } from '@tanstack/react-router';
import type { InboundWebhookEndpoint } from '@agent-console/shared';
import { ReceiveUrl } from './ReceiveUrl';

interface EndpointRowProps {
  repositoryId: string;
  endpoint: InboundWebhookEndpoint;
  busy: boolean;
  /** Rotating is refused while another issued secret is pending or unsaved; other actions stay available. */
  rotateBlocked: boolean;
  onRotate: (endpoint: InboundWebhookEndpoint) => void;
  onClearPrevious: (endpoint: InboundWebhookEndpoint) => void;
  onDelete: (endpoint: InboundWebhookEndpoint) => void;
}

export function EndpointRow({
  repositoryId,
  endpoint,
  busy,
  rotateBlocked,
  onRotate,
  onClearPrevious,
  onDelete,
}: EndpointRowProps) {
  return (
    <div className="card flex flex-col gap-2" data-testid={`endpoint-${endpoint.id}`}>
      <div className="text-lg font-medium">{endpoint.label}</div>
      <div
        data-testid="endpoint-instruction"
        title={endpoint.instructionText}
        className="text-sm text-gray-400 whitespace-pre-wrap break-words line-clamp-4"
      >
        {endpoint.instructionText}
      </div>
      <ReceiveUrl endpointId={endpoint.id} />
      {endpoint.hasPreviousSecret && endpoint.previousSecretExpiresAt && (
        <div className="text-sm text-yellow-300">
          Previous secret still valid until {new Date(endpoint.previousSecretExpiresAt).toLocaleString()}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Link
          to="/settings/repositories/$repositoryId/inbound-webhooks/$endpointId/edit"
          params={{ repositoryId, endpointId: endpoint.id }}
          className="btn text-sm no-underline"
        >
          Edit
        </Link>
        <button type="button" className="btn text-sm" onClick={() => onRotate(endpoint)} disabled={busy || rotateBlocked}>
          Rotate secret
        </button>
        {endpoint.hasPreviousSecret && (
          <button type="button" className="btn text-sm" onClick={() => onClearPrevious(endpoint)} disabled={busy}>
            End previous secret now
          </button>
        )}
        <button type="button" className="btn btn-danger text-sm" onClick={() => onDelete(endpoint)} disabled={busy}>
          Delete
        </button>
      </div>
    </div>
  );
}
