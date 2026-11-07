import {
  INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
  INBOUND_WEBHOOK_LABEL_MAX_LENGTH,
} from '@agent-console/shared';

/**
 * Client-side mirror of the server's request rules for an inbound webhook
 * endpoint's operator-authored fields. The server remains the authority; this
 * only avoids a round trip for input it is certain to refuse.
 * Returns an error message, or null when the value is acceptable.
 */
export function validateInstructionText(value: string): string | null {
  if (/[\r\n]/.test(value)) return 'Instruction text must be a single line';
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
