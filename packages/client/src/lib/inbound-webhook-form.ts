import * as v from 'valibot';
import {
  INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
  INBOUND_WEBHOOK_LABEL_MAX_LENGTH,
  InboundWebhookSecretSchema,
} from '@agent-console/shared';

/**
 * Client-side mirror of the server's request rules for an inbound webhook
 * endpoint's operator-authored fields. The server remains the authority; this
 * only avoids a round trip for input it is certain to refuse.
 * Returns an error message, or null when the value is acceptable.
 */
export function validateInstructionText(value: string): string | null {
  if (value.length > INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH) {
    return `Instruction text must be at most ${INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH} characters`;
  }
  if (value.trim().length === 0) return 'Instruction text is required';
  return null;
}

export function validateLabel(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Label is required';
  if (trimmed.length > INBOUND_WEBHOOK_LABEL_MAX_LENGTH) {
    return `Label must be at most ${INBOUND_WEBHOOK_LABEL_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * Validates an entered signing secret with the shared schema, so the rule is
 * the server's rule. Every message of that schema names only the rule, never
 * the value; this function returns one of them and nothing derived from the
 * input.
 */
export function validateEnteredSecret(value: string): string | null {
  const result = v.safeParse(InboundWebhookSecretSchema, value);
  return result.success ? null : (result.issues[0]?.message ?? 'Secret is invalid');
}

/** How the signing secret of a create or a rotate is chosen. */
export type SecretSourceChoice = 'generate' | 'enter';

/** Base URL part of the receive URL for an endpoint id; `origin` null means the setting is unset. */
export function buildReceiveUrl(
  internetOrigin: string | null,
  endpointId: string,
): { path: string; url: string; hasOrigin: boolean } {
  const path = `/webhooks/in/${endpointId}`;
  return internetOrigin === null
    ? { path, url: path, hasOrigin: false }
    : { path, url: `${internetOrigin}${path}`, hasOrigin: true };
}
