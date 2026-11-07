import { useState } from 'react';
import type { InboundWebhookEndpoint } from '@agent-console/shared';
import { INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH, INBOUND_WEBHOOK_LABEL_MAX_LENGTH } from '@agent-console/shared';
import { validateInstructionText, validateLabel } from '../../lib/inbound-webhook-form';

interface EndpointRowProps {
  endpoint: InboundWebhookEndpoint;
  repositoryName: string;
  busy: boolean;
  /** Rotating is refused while another issued secret is pending or unsaved; other actions stay available. */
  rotateBlocked: boolean;
  onSave: (id: string, changes: { label: string; instructionText: string }) => Promise<void>;
  onRotate: (endpoint: InboundWebhookEndpoint) => void;
  onClearPrevious: (endpoint: InboundWebhookEndpoint) => void;
  onDelete: (endpoint: InboundWebhookEndpoint) => void;
}

export function EndpointRow({
  endpoint,
  repositoryName,
  busy,
  rotateBlocked,
  onSave,
  onRotate,
  onClearPrevious,
  onDelete,
}: EndpointRowProps) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(endpoint.label);
  const [instructionText, setInstructionText] = useState(endpoint.instructionText);

  const labelError = validateLabel(label);
  const instructionError = validateInstructionText(instructionText);

  const startEditing = () => {
    setLabel(endpoint.label);
    setInstructionText(endpoint.instructionText);
    setEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (labelError || instructionError) return;
    try {
      await onSave(endpoint.id, { label: label.trim(), instructionText });
      setEditing(false);
    } catch {
      // The parent reports the error; stay in edit mode.
    }
  };

  return (
    <div className="card flex flex-col gap-2" data-testid={`endpoint-${endpoint.id}`}>
      {editing ? (
        <form onSubmit={handleSave} className="flex flex-col gap-2">
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex flex-col gap-1">
              Label
              <input
                type="text"
                className="input"
                value={label}
                maxLength={INBOUND_WEBHOOK_LABEL_MAX_LENGTH}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            {labelError && <span className="text-red-400">{labelError}</span>}
          </div>
          <div className="text-sm text-gray-500">Repository: {repositoryName} (fixed after creation)</div>
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex flex-col gap-1">
              Instruction text
              <input
                type="text"
                className="input"
                value={instructionText}
                maxLength={INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH}
                onChange={(e) => setInstructionText(e.target.value)}
              />
            </label>
            {instructionError && <span className="text-red-400">{instructionError}</span>}
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary text-sm"
              disabled={busy || labelError !== null || instructionError !== null}
            >
              Save
            </button>
            <button type="button" className="btn text-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="text-lg font-medium">{endpoint.label}</div>
          <div className="text-sm text-gray-500">Repository: {repositoryName}</div>
          <div className="text-sm text-gray-400 break-words">Instruction: {endpoint.instructionText}</div>
          <div className="text-sm text-gray-500">
            Endpoint path: <code>/webhooks/in/{endpoint.id}</code>
          </div>
          {endpoint.hasPreviousSecret && endpoint.previousSecretExpiresAt && (
            <div className="text-sm text-yellow-300">
              Previous secret still valid until {new Date(endpoint.previousSecretExpiresAt).toLocaleString()}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn text-sm" onClick={startEditing} disabled={busy}>
              Edit
            </button>
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
        </>
      )}
    </div>
  );
}
