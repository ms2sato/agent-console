import { createHmac, randomBytes } from 'node:crypto';

/** Prefix of a Standard Webhooks signing secret. */
export const INBOUND_WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * Raw secret length. Senders accept 24..64 raw bytes before base64 encoding;
 * 32 sits in the middle of that range.
 */
export const INBOUND_WEBHOOK_SECRET_BYTES = 32;

/** How long the outgoing secret stays valid after a rotation. */
export const INBOUND_WEBHOOK_PREVIOUS_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

/** A new `whsec_<base64>` signing secret from a CSPRNG. */
export function generateInboundWebhookSecret(): string {
  return `${INBOUND_WEBHOOK_SECRET_PREFIX}${randomBytes(INBOUND_WEBHOOK_SECRET_BYTES).toString('base64')}`;
}

/** ISO 8601 expiry of a secret that is rotated out at `now`. */
export function previousSecretExpiryFrom(now: Date): string {
  return new Date(now.getTime() + INBOUND_WEBHOOK_PREVIOUS_SECRET_GRACE_MS).toISOString();
}

/**
 * Whether a previous secret is still honoured at `now`: it has an expiry and that expiry is
 * strictly in the future. The single writer of this rule; the management wire and the verifier
 * both call it.
 */
export function isPreviousSecretActive(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && Date.parse(expiresAt) > now.getTime();
}

/**
 * The raw HMAC-SHA256 digest of one Standard Webhooks message: input `{id}.{timestamp}.{body}`,
 * keyed by the base64-DECODED bytes of the part after `whsec_`. `null` when the secret lacks the
 * prefix. The single writer of the signed string and of the key decoding: signing and verifying
 * both go through it.
 */
export function computeStandardWebhookDigest(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): Buffer | null {
  if (!secret.startsWith(INBOUND_WEBHOOK_SECRET_PREFIX)) return null;
  const key = Buffer.from(secret.slice(INBOUND_WEBHOOK_SECRET_PREFIX.length), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
}

/** `v1,<base64>` signature header value for one message. Throws on a secret without the prefix. */
export function signStandardWebhook(input: { secret: string; id: string; timestamp: string; body: string }): string {
  const digest = computeStandardWebhookDigest(input.secret, input.id, input.timestamp, input.body);
  if (digest === null) throw new Error('Signing secret does not carry the expected prefix');
  return `v1,${digest.toString('base64')}`;
}
