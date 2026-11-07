import { describe, it, expect } from 'bun:test';
import {
  INBOUND_WEBHOOK_PREVIOUS_SECRET_GRACE_MS,
  INBOUND_WEBHOOK_SECRET_BYTES,
  INBOUND_WEBHOOK_SECRET_PREFIX,
  generateInboundWebhookSecret,
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
    expect(new RegExp(`^${ISO8601_GLOB_PATTERN.replaceAll('[0-9]', '\\d').replace('*', '.*')}$`).test(expiry)).toBe(true);
  });

  it('does not mutate its argument', () => {
    const now = new Date('2026-11-07T12:00:00.000Z');
    previousSecretExpiryFrom(now);
    expect(now.toISOString()).toBe('2026-11-07T12:00:00.000Z');
  });
});
