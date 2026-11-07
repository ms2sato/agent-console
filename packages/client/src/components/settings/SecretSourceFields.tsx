import { useId } from 'react';
import type { SecretSourceChoice } from '../../lib/inbound-webhook-form';
import { validateEnteredSecret } from '../../lib/inbound-webhook-form';

interface SecretSourceFieldsProps {
  source: SecretSourceChoice;
  secret: string;
  disabled?: boolean;
  onSourceChange: (source: SecretSourceChoice) => void;
  onSecretChange: (secret: string) => void;
}

/**
 * "Generate" (default) or "Enter my own" signing secret. The entered value is
 * a password field that autofill leaves alone; the parent owns the state and
 * clears it on submit.
 */
export function SecretSourceFields({ source, secret, disabled, onSourceChange, onSecretChange }: SecretSourceFieldsProps) {
  const groupName = useId();
  const secretError = source === 'enter' && secret !== '' ? validateEnteredSecret(secret) : null;

  return (
    <fieldset className="flex flex-col gap-2 text-sm" disabled={disabled}>
      <legend className="mb-1">Signing secret</legend>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name={groupName}
          checked={source === 'generate'}
          onChange={() => onSourceChange('generate')}
        />
        Generate
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name={groupName}
          checked={source === 'enter'}
          onChange={() => onSourceChange('enter')}
        />
        Enter my own
      </label>
      {source === 'enter' && (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            Secret
            <input
              type="password"
              autoComplete="off"
              className="input"
              value={secret}
              onChange={(e) => onSecretChange(e.target.value)}
            />
          </label>
          {secretError && <span className="text-red-400">{secretError}</span>}
          <span className="text-gray-500">whsec_ followed by base64 of 24 to 64 bytes.</span>
        </div>
      )}
    </fieldset>
  );
}
