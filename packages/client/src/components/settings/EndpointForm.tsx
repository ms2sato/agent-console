import { useState } from 'react';
import {
  INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
  INBOUND_WEBHOOK_LABEL_MAX_LENGTH,
  INBOUND_WEBHOOK_REPLY_URL_IN_REPLY_TO_PLACEHOLDER,
} from '@agent-console/shared';
import {
  validateEnteredSecret,
  validateInstructionText,
  validateLabel,
  validateReplyUrl,
  replyUrlRequestField,
  type SecretSourceChoice,
} from '../../lib/inbound-webhook-form';
import { Spinner } from '../ui/Spinner';
import { SecretSourceFields } from './SecretSourceFields';
import type { TakeSecret } from './hooks/useInboundWebhookEndpoints';

export interface EndpointFormPayload {
  label: string;
  instructionText: string;
  /**
   * Absent when the form has nothing to send for it. Create: a string only when the field is
   * non-empty. Edit: the new string when changed, `null` when a stored value was emptied.
   */
  replyUrl?: string | null;
  /** Present only for an entered secret on create; reads the value once, then forgets it. */
  takeSecret?: TakeSecret;
}

interface EndpointFormProps {
  /** `create` adds the secret-source choice; `edit` has none. */
  mode: 'create' | 'edit';
  initial?: { label: string; instructionText: string; replyUrl: string | null };
  isPending: boolean;
  onSubmit: (payload: EndpointFormPayload) => Promise<void>;
}

const REPLY_URL_ERROR_ID = 'endpoint-reply-url-error';

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
  const [replyUrl, setReplyUrl] = useState(initial?.replyUrl ?? '');
  // The baseline the draft is compared against is the value at mount, the same moment the draft was seeded:
  // a refetch that changes `initial` while the form stays mounted must not turn an untouched draft into a change.
  const [replyUrlBaseline] = useState(initial?.replyUrl ?? null);
  const [secretSource, setSecretSource] = useState<SecretSourceChoice>('generate');
  const [secret, setSecret] = useState('');

  const labelError = label ? validateLabel(label) : null;
  const instructionError = instructionText ? validateInstructionText(instructionText) : null;
  const replyUrlError = validateReplyUrl(replyUrl);
  const secretValid = mode === 'edit' || secretSource === 'generate' || validateEnteredSecret(secret) === null;
  const canSubmit =
    !isPending && validateLabel(label) === null && validateInstructionText(instructionText) === null &&
    replyUrlError === null &&
    secretValid;

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
        ...replyUrlRequestField(mode, replyUrl, replyUrlBaseline),
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
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex flex-col gap-1">
          Reply URL (optional)
          <input
            type="text"
            className="input"
            value={replyUrl}
            onChange={(e) => setReplyUrl(e.target.value)}
            disabled={isPending}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://sender.example.com/replies"
            aria-invalid={replyUrlError !== null}
            aria-describedby={replyUrlError ? REPLY_URL_ERROR_ID : undefined}
          />
        </label>
        <span className="text-gray-500">
          Where a signed reply to a delivery is sent. Leave empty to refuse replies. An https address; it is never shown to agents.{' '}
          {`To address the message being answered, put ${INBOUND_WEBHOOK_REPLY_URL_IN_REPLY_TO_PLACEHOLDER} as a path segment, for example https://example.com/reply/${INBOUND_WEBHOOK_REPLY_URL_IN_REPLY_TO_PLACEHOLDER}; the server replaces it with that message's id.`}
        </span>
        {replyUrlError && (
          <span id={REPLY_URL_ERROR_ID} className="text-red-400">
            {replyUrlError}
          </span>
        )}
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
