import { describe, it, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  INBOUND_WEBHOOK_PREVIOUS_SECRET_GRACE_MS,
  INBOUND_WEBHOOK_SECRET_BYTES,
  INBOUND_WEBHOOK_SECRET_PREFIX,
  computeStandardWebhookDigest,
  generateInboundWebhookSecret,
  signStandardWebhook,
  isPreviousSecretActive,
  previousSecretExpiryFrom,
} from '../inbound-webhook-secret.js';
import { ISO8601_GLOB_PATTERN } from '../../database/schema-helpers.js';

describe('generateInboundWebhookSecret', () => {
  it('is whsec_ followed by the base64 of exactly 32 random bytes', () => {
    const secret = generateInboundWebhookSecret();
    expect(secret.startsWith(INBOUND_WEBHOOK_SECRET_PREFIX)).toBe(true);
    const encoded = secret.slice(INBOUND_WEBHOOK_SECRET_PREFIX.length);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(encoded, 'base64').length).toBe(INBOUND_WEBHOOK_SECRET_BYTES);
    expect(INBOUND_WEBHOOK_SECRET_BYTES).toBe(32);
  });

  it('stays inside the 24..64 raw-byte window the sender requires', () => {
    expect(INBOUND_WEBHOOK_SECRET_BYTES).toBeGreaterThanOrEqual(24);
    expect(INBOUND_WEBHOOK_SECRET_BYTES).toBeLessThanOrEqual(64);
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateInboundWebhookSecret()));
    expect(secrets.size).toBe(50);
  });
});

describe('previousSecretExpiryFrom', () => {
  it('is exactly 24 hours after the rotation time, in the ISO 8601 shape the column CHECK accepts', () => {
    const now = new Date('2026-11-07T12:00:00.000Z');
    const expiry = previousSecretExpiryFrom(now);
    expect(expiry).toBe('2026-11-08T12:00:00.000Z');
    expect(INBOUND_WEBHOOK_PREVIOUS_SECRET_GRACE_MS).toBe(24 * 60 * 60 * 1000);
    expect(new RegExp(`^${ISO8601_GLOB_PATTERN.replaceAll('[0-9]', '\\d').replaceAll('*', '.*')}$`).test(expiry)).toBe(true);
  });

  it('does not mutate its argument', () => {
    const now = new Date('2026-11-07T12:00:00.000Z');
    previousSecretExpiryFrom(now);
    expect(now.toISOString()).toBe('2026-11-07T12:00:00.000Z');
  });
});

describe('isPreviousSecretActive', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');

  it('is true only while the expiry is strictly in the future', () => {
    expect(isPreviousSecretActive('2026-11-07T12:00:00.001Z', now)).toBe(true);
    expect(isPreviousSecretActive('2026-11-07T12:00:00.000Z', now)).toBe(false);
    expect(isPreviousSecretActive('2026-11-07T11:59:59.999Z', now)).toBe(false);
  });

  it('is false without an expiry or with an unparsable one', () => {
    expect(isPreviousSecretActive(null, now)).toBe(false);
    expect(isPreviousSecretActive('not a date', now)).toBe(false);
  });
});

describe('signStandardWebhook', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const id = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
  const timestamp = '1700000000';
  const body = '{"a":1}';

  // Written from the Standard Webhooks specification, not from production code: HMAC-SHA256 over
  // `id.timestamp.body`, key = base64-decoded part after `whsec_`, value = `v1,` + base64.
  const specSignature = (): string => {
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  };

  it('equals the independently computed specification vector', () => {
    expect(signStandardWebhook({ secret, id, timestamp, body })).toBe(specSignature());
  });

  it('the raw digest is the same bytes the signature carries', () => {
    const digest = computeStandardWebhookDigest(secret, id, timestamp, body);
    expect(`v1,${digest?.toString('base64')}`).toBe(specSignature());
  });

  it('a different id, timestamp or body changes the signature', () => {
    const base = signStandardWebhook({ secret, id, timestamp, body });
    expect(signStandardWebhook({ secret, id: `${id}x`, timestamp, body })).not.toBe(base);
    expect(signStandardWebhook({ secret, id, timestamp: '1700000001', body })).not.toBe(base);
    expect(signStandardWebhook({ secret, id, timestamp, body: `${body} ` })).not.toBe(base);
  });

  it('throws for a secret without the whsec_ prefix, and the digest is null', () => {
    expect(() => signStandardWebhook({ secret: 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', id, timestamp, body })).toThrow();
    expect(computeStandardWebhookDigest('plain', id, timestamp, body)).toBeNull();
  });
});
