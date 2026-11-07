import { useState } from 'react';

interface SecretRevealPanelProps {
  endpointLabel: string;
  secret: string;
  onDismiss: () => void;
}

/**
 * Shows a signing secret exactly once. The parent owns the value in component
 * state and removes it on dismiss; nothing here persists it.
 */
export function SecretRevealPanel({ endpointLabel, secret, onDismiss }: SecretRevealPanelProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div
      role="alert"
      aria-label="Signing secret"
      className="mb-6 p-4 bg-yellow-900/30 border border-yellow-600 rounded text-yellow-100"
    >
      <h2 className="text-lg font-medium mb-1">Signing secret for &quot;{endpointLabel}&quot;</h2>
      <p className="text-sm mb-3">
        This secret is shown only once and cannot be shown again. Copy it now and enter it where requests
        are signed. If it is lost, rotate the secret.
      </p>
      <div className="flex gap-2 items-center">
        <code data-testid="issued-secret" className="flex-1 min-w-0 break-all bg-slate-900 rounded px-2 py-1 text-sm">
          {secret}
        </code>
        <button type="button" className="btn btn-primary text-sm shrink-0" onClick={handleCopy}>
          {copyState === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyState === 'failed' && (
        <p className="text-sm text-red-300 mt-2">Could not copy automatically. Select the secret and copy it manually.</p>
      )}
      <div className="mt-3">
        <button type="button" className="btn text-sm" onClick={onDismiss}>
          I have saved the secret
        </button>
      </div>
    </div>
  );
}
