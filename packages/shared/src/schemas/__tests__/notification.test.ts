import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  RepositorySlackIntegrationInputSchema,
  RepositorySlackIntegrationSchema,
  NotificationStatusResponseSchema,
  type RepositorySlackIntegration,
} from '../notification';

describe('RepositorySlackIntegrationInputSchema', () => {
  it('should accept a valid webhook URL and default enabled to true', () => {
    const result = v.safeParse(RepositorySlackIntegrationInputSchema, {
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.webhookUrl).toBe('https://hooks.slack.com/services/T00/B00/XXXX');
      expect(result.output.enabled).toBe(true);
    }
  });

  it('should accept an explicit enabled: false', () => {
    const result = v.safeParse(RepositorySlackIntegrationInputSchema, {
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX',
      enabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.enabled).toBe(false);
    }
  });

  it('should reject a missing webhookUrl', () => {
    const result = v.safeParse(RepositorySlackIntegrationInputSchema, {
      enabled: true,
    });
    expect(result.success).toBe(false);
  });

  it('should reject a non-Slack webhook URL', () => {
    const result = v.safeParse(RepositorySlackIntegrationInputSchema, {
      webhookUrl: 'https://example.com/hook',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(RepositorySlackIntegrationInputSchema, {
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });
});

// Key-set pin. `RepositorySlackIntegration` is derived from `RepositorySlackIntegrationSchema`,
// so the schema is the only place a field is edited; the pin compares `keyof` with an explicit
// literal union, so a field added to (or removed from) the schema alone is a `tsc` failure
// (TS2344) naming the difference. `Assert<Equals<...>>` is the form that fails under drift; a
// `declare const x: never` form would type-check under it.
//
// Measured reach: (`tsc` diagnostics, control clean first): adding a field to, or removing
// one from, `RepositorySlackIntegrationSchema` fails `_RepositorySlackIntegrationKeys` (TS2344); an added
// field also fails the entity fixture below (TS2769) because the fixture lacks it. The pin's diagnostic does
// not name the key.
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type _RepositorySlackIntegrationKeys = Assert<
  Equals<keyof RepositorySlackIntegration, 'id' | 'repositoryId' | 'webhookUrl' | 'enabled' | 'createdAt' | 'updatedAt'>
>;

describe('RepositorySlackIntegrationSchema', () => {
  const entity = {
    id: 'slack-1',
    repositoryId: 'repo-1',
    webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX',
    enabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('accepts the documented entity and round-trips it unchanged', () => {
    const result = v.safeParse(RepositorySlackIntegrationSchema, entity);
    expect(result.success).toBe(true);
    if (result.success) expect(result.output).toEqual(entity);
  });

  it('rejects an extra field and each dropped field', () => {
    expect(v.safeParse(RepositorySlackIntegrationSchema, { ...entity, extra: 1 }).success).toBe(false);
    for (const key of Object.keys(entity)) {
      const { [key]: _dropped, ...rest } = entity as Record<string, unknown>;
      expect(v.safeParse(RepositorySlackIntegrationSchema, rest).success).toBe(false);
    }
  });

  it('rejects a non-boolean enabled (the database integer must be converted before the wire)', () => {
    expect(v.safeParse(RepositorySlackIntegrationSchema, { ...entity, enabled: 1 }).success).toBe(false);
  });
});

describe('NotificationStatusResponseSchema', () => {
  it('accepts a configured and an unconfigured status', () => {
    expect(
      v.safeParse(NotificationStatusResponseSchema, { baseUrl: 'https://x.example', isBaseUrlConfigured: true })
        .success,
    ).toBe(true);
    expect(v.safeParse(NotificationStatusResponseSchema, { baseUrl: '', isBaseUrlConfigured: false }).success).toBe(
      true,
    );
  });

  it('rejects an extra field and each dropped field', () => {
    expect(
      v.safeParse(NotificationStatusResponseSchema, { baseUrl: '', isBaseUrlConfigured: false, extra: 1 }).success,
    ).toBe(false);
    expect(v.safeParse(NotificationStatusResponseSchema, { isBaseUrlConfigured: false }).success).toBe(false);
    expect(v.safeParse(NotificationStatusResponseSchema, { baseUrl: '' }).success).toBe(false);
  });
});
