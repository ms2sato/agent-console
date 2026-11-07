import { useState } from 'react';
import type { InboundWebhookEndpoint } from '@agent-console/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { validateEnteredSecret, type SecretSourceChoice } from '../../lib/inbound-webhook-form';
import { SecretSourceFields } from './SecretSourceFields';
import type { TakeSecret } from './hooks/useInboundWebhookEndpoints';

interface RotateSecretDialogProps {
  endpoint: InboundWebhookEndpoint;
  onCancel: () => void;
  /** Called once with the endpoint and, for an entered secret, a one-shot reader of it. */
  onRotate: (endpoint: InboundWebhookEndpoint, takeSecret?: TakeSecret) => void;
}

/**
 * Mounted only while a rotation is being chosen, so the entered secret in its
 * state is dropped with the dialog: on submit and on cancel alike.
 */
export function RotateSecretDialog({ endpoint, onCancel, onRotate }: RotateSecretDialogProps) {
  const [source, setSource] = useState<SecretSourceChoice>('generate');
  const [secret, setSecret] = useState('');

  const canRotate = source === 'generate' || validateEnteredSecret(secret) === null;

  const handleRotate = () => {
    if (!canRotate) return;
    if (source === 'enter') {
      let held: string | undefined = secret;
      setSecret('');
      onRotate(endpoint, () => {
        const taken = held;
        held = undefined;
        return taken;
      });
    } else {
      onRotate(endpoint);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rotate secret</AlertDialogTitle>
          <AlertDialogDescription>
            {`The current secret of "${endpoint.label}" keeps working for 24 hours after rotation.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <SecretSourceFields
          source={source}
          secret={secret}
          onSourceChange={(next) => {
            setSource(next);
            setSecret('');
          }}
          onSecretChange={setSecret}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRotate} disabled={!canRotate}>
            Rotate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
