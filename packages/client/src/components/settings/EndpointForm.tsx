import { useState } from 'react';
import {
  INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
  INBOUND_WEBHOOK_LABEL_MAX_LENGTH,
} from '@agent-console/shared';
import {
  validateEnteredSecret,
  validateInstructionText,
  validateLabel,
  type SecretSourceChoice,
} from '../../lib/inbound-webhook-form';
import { Spinner } from '../ui/Spinner';
import { SecretSourceFields } from './SecretSourceFields';
import type { TakeSecret } from './hooks/useInboundWebhookEndpoints';

export interface EndpointFormPayload {
  label: string;
  instructionText: string;
  /** Present only for an entered secret on create; reads the value once, then forgets it. */
  takeSecret?: TakeSecret;
}

interface EndpointFormProps {
  /** `create` adds the secret-source choice; `edit` has none. */
  mode: 'create' | 'edit';
  initial?: { label: string; instructionText: string };
  isPending: boolean;
  onSubmit: (payload: EndpointFormPayload) => Promise<void>;
}

/** One-shot holder: the first call returns the value and drops it. */
function oneShot(value: string): TakeSecret {
  let held: string | undefined = value;
  return () => {
    const taken = held;
    held = undefined;
    return taken;
  };
}

export function EndpointForm({ mode, initial, isPending, onSubmit }: EndpointFormProps) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [instructionText, setInstructionText] = useState(initial?.instructionText ?? '');
  const [secretSource, setSecretSource] = useState<SecretSourceChoice>('generate');
  const [secret, setSecret] = useState('');

  const labelError = label ? validateLabel(label) : null;
  const instructionError = instructionText ? validateInstructionText(instructionText) : null;
  const secretValid = mode === 'edit' || secretSource === 'generate' || validateEnteredSecret(secret) === null;
  const canSubmit =
    !isPending && validateLabel(label) === null && validateInstructionText(instructionText) === null && secretValid;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const enteredSecret = mode === 'create' && secretSource === 'enter' ? secret : undefined;
    // The entered secret leaves component state at submit; the mutation reads it once through the closure.
    if (enteredSecret !== undefined) setSecret('');
    try {
      await onSubmit({
        label: label.trim(),
        instructionText,
        ...(enteredSecret !== undefined ? { takeSecret: oneShot(enteredSecret) } : {}),
      });
    } catch {
      // The page reports the error; the label and instruction stay for another attempt.
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card flex flex-col gap-4">
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
          <textarea
            className="input min-h-32"
            rows={6}
            value={instructionText}
            maxLength={INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH}
            onChange={(e) => setInstructionText(e.target.value)}
            disabled={isPending}
          />
        </label>
        <span className="text-gray-500">
          Up to {INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH} characters, line breaks allowed. Delivered with every message.
        </span>
        {instructionError && <span className="text-red-400">{instructionError}</span>}
      </div>
      {mode === 'create' && (
        <SecretSourceFields
          source={secretSource}
          secret={secret}
          disabled={isPending}
          onSourceChange={(next) => {
            setSecretSource(next);
            setSecret('');
          }}
          onSecretChange={setSecret}
        />
      )}
      <div>
        <button type="submit" className="btn btn-primary text-sm" disabled={!canSubmit}>
          {isPending ? <Spinner size="sm" /> : mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </form>
  );
}
