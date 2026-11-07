import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateInboundWebhookEndpointRequestSchema,
  UpdateInboundWebhookEndpointRequestSchema,
  InboundWebhookEndpointSchema,
  InboundWebhookEndpointResponseSchema,
  InboundWebhookEndpointWithSecretResponseSchema,
  InboundWebhookEndpointsListResponseSchema,
} from '../inbound-webhook-endpoint';

const VALID_CREATE = { label: 'Slack', repositoryId: 'repo-1', instructionText: 'Run the triage skill' };

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

  it('requires repositoryId (missing and empty)', () => {
    const { repositoryId: _omitted, ...withoutRepository } = VALID_CREATE;
    expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, withoutRepository).success).toBe(false);
    expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, repositoryId: '' }).success).toBe(false);
  });

  it('label boundaries: empty, blank and 101 chars rejected; 1 and 100 accepted', () => {
    for (const label of ['', '   ', 'x'.repeat(101)]) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, label }).success).toBe(false);
    }
    for (const label of ['x', 'x'.repeat(100)]) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, label }).success).toBe(true);
    }
  });

  it('instructionText boundaries: LF, CR, trailing LF, 301 chars, empty and blank rejected; 1 and 300 accepted', () => {
    for (const instructionText of ['a\nb', 'a\rb', 'abc\n', '\r\n', 'x'.repeat(301), '', '   ']) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, instructionText }).success).toBe(false);
    }
    for (const instructionText of ['x', 'x'.repeat(300), 'a\tb', ' padded ']) {
      expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, instructionText }).success).toBe(true);
    }
  });

  it('does not trim the instruction (the stored text is what the operator wrote)', () => {
    const result = v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, instructionText: ' padded ' });
    expect(result.success && result.output.instructionText).toBe(' padded ');
  });

  it('rejects unknown keys, notably a caller-chosen secret', () => {
    expect(v.safeParse(CreateInboundWebhookEndpointRequestSchema, { ...VALID_CREATE, secret: 'whsec_mine' }).success).toBe(false);
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
    expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, { instructionText: 'a\nb' }).success).toBe(false);
    expect(v.safeParse(UpdateInboundWebhookEndpointRequestSchema, { instructionText: 'x'.repeat(301) }).success).toBe(false);
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

  it('the single-endpoint wrapper carries no secret; the with-secret wrapper requires one', () => {
    expect(v.safeParse(InboundWebhookEndpointResponseSchema, { endpoint: ENDPOINT }).success).toBe(true);
    expect(v.safeParse(InboundWebhookEndpointResponseSchema, { endpoint: ENDPOINT, secret: 'whsec_x' }).success).toBe(false);
    expect(v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, { endpoint: ENDPOINT, secret: 'whsec_x' }).success).toBe(true);
    expect(v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, { endpoint: ENDPOINT }).success).toBe(false);
    expect(v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, { endpoint: ENDPOINT, secret: '' }).success).toBe(false);
  });
});
