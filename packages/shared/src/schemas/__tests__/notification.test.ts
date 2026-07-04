import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { RepositorySlackIntegrationInputSchema } from '../notification';

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
