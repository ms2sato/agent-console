import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateInboundWebhookEndpointRequestSchema,
  InboundWebhookSecretSchema,
  RotateInboundWebhookSecretRequestSchema,
  UpdateInboundWebhookEndpointRequestSchema,
  InboundWebhookEndpointSchema,
  InboundWebhookEndpointResponseSchema,
  InboundWebhookEndpointWithSecretResponseSchema,
  InboundWebhookEndpointsListResponseSchema,
} from '../inbound-webhook-endpoint';

const VALID_CREATE = { label: 'Slack', instructionText: 'Run the triage skill' };

/** `whsec_` plus base64 of `bytes` zero-filled bytes (canonical by construction). */
function secretOfBytes(bytes: number): string {
  return `whsec_${Buffer.alloc(bytes, 7).toString('base64')}`;
}

const ENDPOINT = {
  id: 'ep-1',
  label: 'Slack',
  repositoryId: 'repo-1',
  instructionText: 'Run the triage skill',
  hasPreviousSecret: false,
  previousSecretExpiresAt: null,
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
};

describe('CreateInboundWebhookEndpointRequestSchema', () => {
  it('accepts a valid body and trims the label', () => {
    const result = v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, label: '  Slack  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.label).toBe('Slack');
  });

  it('rejects repositoryId in the body (the repository is a path segment)', () => {
    expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, repositoryId: 'repo-1' }).success).toBe(false);
  });

  it('label boundaries: empty, blank and 101 chars rejected; 1 and 100 accepted', () => {
    for (const label of ['', '   ', 'x'.repeat(101)]) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, label }).success).toBe(false);
    }
    for (const label of ['x', 'x'.repeat(100)]) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, label }).success).toBe(true);
    }
  });

  it('instructionText boundaries: 4001 chars, empty and blank rejected; 1 and 4000 accepted', () => {
    for (const instructionText of ['x'.repeat(4001), '', '   ', '\n\r\n']) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, instructionText }).success).toBe(false);
    }
    for (const instructionText of ['x', 'x'.repeat(4000), 'a\tb', ' padded ']) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, instructionText }).success).toBe(true);
    }
  });

  it('accepts LF, CR and CRLF inside the instruction, unchanged', () => {
    for (const instructionText of ['a\nb', 'a\rb', 'a\r\nb', 'abc\n', '\nlead']) {
      const result = v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, instructionText });
      expect(result.success && result.output.instructionText).toBe(instructionText);
    }
  });

  it('does not trim the instruction (the stored text is what the operator wrote)', () => {
    const result = v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, instructionText: ' padded ' });
    expect(result.success && result.output.instructionText).toBe(' padded ');
  });

  it('secret is optional and, when present, goes through the secret schema', () => {
    expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, secret: secretOfBytes(32) }).success).toBe(true);
    expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, secret: 'whsec_short' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, previousSecret: 'x' }).success).toBe(false);
  });
});

describe('InboundWebhookSecretSchema', () => {
  const accepted: Array<[string, string]> = [
    ['24 bytes', secretOfBytes(24)],
    ['32 bytes', secretOfBytes(32)],
    ['64 bytes', secretOfBytes(64)],
    ['padded base64 (25 bytes)', secretOfBytes(25)],
  ];
  const rejected: Array<[string, string]> = [
    ['missing prefix', Buffer.alloc(32, 7).toString('base64')],
    ['wrong prefix', `whsec-${Buffer.alloc(32, 7).toString('base64')}`],
    ['non-base64 characters', `whsec_${'!'.repeat(32)}`],
    ['whitespace inside', `whsec_${Buffer.alloc(16, 7).toString('base64')} ${Buffer.alloc(16, 7).toString('base64')}`],
    ['23 bytes', secretOfBytes(23)],
    ['65 bytes', secretOfBytes(65)],
    ['non-zero trailing bits (lax decodable, non-canonical)', `whsec_${Buffer.alloc(32, 7).toString('base64').slice(0, -2)}B=`],
    ['missing padding', secretOfBytes(25).replace(/=+$/, '')],
  ];

  for (const [name, value] of accepted) {
    it(`accepts ${name}`, () => {
      expect(v.safeParse(InboundWebhookSecretSchema, value).success).toBe(true);
    });
  }

  for (const [name, value] of rejected) {
    it(`rejects ${name}, and no issue message contains the value`, () => {
      const result = v.safeParse(InboundWebhookSecretSchema, value);
      expect(result.success).toBe(false);
      for (const issue of result.issues ?? []) {
        expect(issue.message).not.toContain(value);
      }
    });
  }

  it('rejects an empty base64 part', () => {
    expect(v.safeParse(InboundWebhookSecretSchema, 'whsec_').success).toBe(false);
  });

  it('rejects a non-string with a message that does not carry the value', () => {
    const result = v.safeParse(InboundWebhookSecretSchema, 123456789);
    expect(result.success).toBe(false);
    expect(result.issues?.[0]?.message).not.toContain('123456789');
  });

  it('every issue message of a value failing all steps is value-free', () => {
    const value = 'whsec_a.b-c d';
    const result = v.safeParse(InboundWebhookSecretSchema, value);
    expect(result.success).toBe(false);
    expect((result.issues ?? []).length).toBeGreaterThan(0);
    for (const issue of result.issues ?? []) {
      expect(issue.message).not.toContain(value);
      expect(issue.message).not.toContain('a.b-c');
    }
  });
});

describe('RotateInboundWebhookSecretRequestSchema', () => {
  it('accepts {} and { secret }, rejects an invalid secret and unknown keys', () => {
    expect(v.safeParse(RotateInboundWebhookSecretRequestSchema, {}).success).toBe(true);
    expect(v.safeParse(RotateInboundWebhookSecretRequestSchema, { secret: secretOfBytes(32) }).success).toBe(true);
    expect(v.safeParse(RotateInboundWebhookSecretRequestSchema, { secret: 'whsec_x' }).success).toBe(false);
    expect(v.safeParse(RotateInboundWebhookSecretRequestSchema, { other: 1 }).success).toBe(false);
  });
});

describe('UpdateInboundWebhookEndpointRequestSchema', () => {
  it('accepts label only, instructionText only, or both', () => {
    for (const body of [{ label: 'x' }, { instructionText: 'y' }, { label: 'x', instructionText: 'y' }]) {
      expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, body).success).toBe(true);
    }
  });

  it('requires at least one field', () => {
    expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, {}).success).toBe(false);
  });

  it('applies the same label and instruction rules', () => {
    expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, { label: ' ' }).success).toBe(false);
    expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, { instructionText: 'x'.repeat(4001) }).success).toBe(false);
    expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, { instructionText: 'a\nb' }).success).toBe(true);
  });

  it('rejects repositoryId, secret and previousSecret', () => {
    for (const extra of [{ repositoryId: 'r' }, { secret: 's' }, { previousSecret: 's' }]) {
      expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, { label: 'x', ...extra }).success).toBe(false);
    }
  });
});

describe('response schemas', () => {
  it('InboundWebhookEndpointSchema accepts the documented shape and rejects a secret field', () => {
    expect(v.safeParse(InboundWebhookEndpointSchema, ENDPOINT).success).toBe(true);
    expect(v.safeParse(InboundWebhookEndpointSchema, { ...ENDPOINT, secret: 'whsec_x' }).success).toBe(false);
    expect(v.safeParse(InboundWebhookEndpointSchema, { ...ENDPOINT, previous_secret: 'whsec_x' }).success).toBe(false);
  });

  it('accepts an active previous secret', () => {
    expect(
      v.safeParse(InboundWebhookEndpointSchema, {
        ...ENDPOINT,
        hasPreviousSecret: true,
        previousSecretExpiresAt: '2026-11-08T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('list wrapper accepts an empty list', () => {
    expect(v.safeParse(InboundWebhookEndpointsListResponseSchema, { endpoints: [] }).success).toBe(true);
  });

  it('the single-endpoint wrapper carries no secret', () => {
    expect(v.safeParse(InboundWebhookEndpointResponseSchema, { endpoint: ENDPOINT }).success).toBe(true);
    expect(v.safeParse(InboundWebhookEndpointResponseSchema, { endpoint: ENDPOINT, secret: 'whsec_x' }).success).toBe(false);
  });

  it('the with-secret response is a variant on secretSource: generated carries the secret, entered carries none', () => {
    const parse = (value: unknown) => v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, value).success;
    expect(parse({ endpoint: ENDPOINT, secretSource: 'generated', secret: 'whsec_x' })).toBe(true);
    expect(parse({ endpoint: ENDPOINT, secretSource: 'entered' })).toBe(true);
    expect(parse({ endpoint: ENDPOINT, secretSource: 'generated' })).toBe(false);
    expect(parse({ endpoint: ENDPOINT, secretSource: 'generated', secret: '' })).toBe(false);
    expect(parse({ endpoint: ENDPOINT, secretSource: 'entered', secret: 'whsec_x' })).toBe(false);
    expect(parse({ endpoint: ENDPOINT, secret: 'whsec_x' })).toBe(false);
    expect(parse({ endpoint: ENDPOINT, secretSource: 'other' })).toBe(false);
  });
});
