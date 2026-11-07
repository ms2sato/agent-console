import { useState } from 'react';
import type { Repository } from '@agent-console/shared';
import { INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH, INBOUND_WEBHOOK_LABEL_MAX_LENGTH } from '@agent-console/shared';
import { validateInstructionText, validateLabel } from '../../lib/inbound-webhook-form';
import { Spinner } from '../ui/Spinner';

interface CreateEndpointFormProps {
  repositories: Repository[];
  isPending: boolean;
  onSubmit: (request: { label: string; repositoryId: string; instructionText: string }) => Promise<void>;
}

export function CreateEndpointForm({ repositories, isPending, onSubmit }: CreateEndpointFormProps) {
  const [repositoryId, setRepositoryId] = useState('');
  const [label, setLabel] = useState('');
  const [instructionText, setInstructionText] = useState('');

  const labelError = label ? validateLabel(label) : null;
  const instructionError = instructionText ? validateInstructionText(instructionText) : null;
  const canSubmit =
    !isPending &&
    repositoryId !== '' &&
    validateLabel(label) === null &&
    validateInstructionText(instructionText) === null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await onSubmit({ label: label.trim(), repositoryId, instructionText });
      setLabel('');
      setInstructionText('');
    } catch {
      // The parent reports the error; keep the input for another attempt.
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card mb-6 flex flex-col gap-3">
      <h2 className="text-lg font-medium">Create Endpoint</h2>
      <label className="flex flex-col gap-1 text-sm">
        Repository
        <select
          className="input"
          value={repositoryId}
          onChange={(e) => setRepositoryId(e.target.value)}
          disabled={isPending}
        >
          <option value="">Select a repository</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex flex-col gap-1">
          Label
          <input
            type="text"
            className="input"
            value={label}
            maxLength={INBOUND_WEBHOOK_LABEL_MAX_LENGTH}
            onChange={(e) => setLabel(e.target.value)}
            disabled={isPending}
          />
        </label>
        {labelError && <span className="text-red-400">{labelError}</span>}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex flex-col gap-1">
          Instruction text
          <input
            type="text"
            className="input"
            value={instructionText}
            maxLength={INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH}
            onChange={(e) => setInstructionText(e.target.value)}
            disabled={isPending}
          />
        </label>
        <span className="text-gray-500">Single line, up to {INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH} characters. Delivered with every message.</span>
        {instructionError && <span className="text-red-400">{instructionError}</span>}
      </div>
      <div>
        <button type="submit" className="btn btn-primary text-sm" disabled={!canSubmit}>
          {isPending ? <Spinner size="sm" /> : 'Create'}
        </button>
      </div>
    </form>
  );
}
