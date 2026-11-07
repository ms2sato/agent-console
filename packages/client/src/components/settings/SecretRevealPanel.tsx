import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';

interface SecretRevealPanelProps {
  endpointLabel: string;
  secret: string;
  /** Rendered between the warning and the secret, e.g. the receive URL. */
  children?: ReactNode;
  /** Replaces the default dismiss button (e.g. a link that leaves the page). */
  action?: ReactNode;
  onDismiss?: () => void;
}

/**
 * Shows a generated signing secret exactly once. The parent owns the value in
 * component state and removes it on dismiss; nothing here persists it.
 */
export function SecretRevealPanel({ endpointLabel, secret, children, action, onDismiss }: SecretRevealPanelProps) {
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
      {children && <div className="mb-3">{children}</div>}
      <div data-testid="secret-block" className="flex gap-2 items-center">
        <code data-testid="issued-secret" className="flex-1 min-w-0 break-all bg-slate-900 rounded px-2 py-1 text-sm">
          {secret}
        </code>
        <CopyButton text={secret} />
      </div>
      <div className="mt-3">
        {action ?? (
          <button type="button" className="btn text-sm" onClick={onDismiss}>
            I have saved the secret
          </button>
        )}
      </div>
    </div>
  );
}
