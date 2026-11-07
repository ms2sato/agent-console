import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  SystemOpenRequestSchema,
  SystemOpenVSCodeRequestSchema,
  SystemHealthResponseSchema,
} from '../system';

describe('SystemOpenRequestSchema', () => {
  it('should accept a valid path', () => {
    const result = v.safeParse(SystemOpenRequestSchema, { path: '/path/to/open' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.path).toBe('/path/to/open');
    }
  });

  it('should reject a missing path', () => {
    const result = v.safeParse(SystemOpenRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject an empty path', () => {
    const result = v.safeParse(SystemOpenRequestSchema, { path: '' });
    expect(result.success).toBe(false);
  });

  it('should reject an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(SystemOpenRequestSchema, {
      path: '/path/to/open',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });
});

describe('SystemOpenVSCodeRequestSchema', () => {
  it('should accept a valid path', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, { path: '/path/to/project' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.path).toBe('/path/to/project');
    }
  });

  it('should reject a missing path', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject an empty path', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, { path: '' });
    expect(result.success).toBe(false);
  });

  it('should reject an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, {
      path: '/path/to/project',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });
});

describe('SystemHealthResponseSchema', () => {
  it('parses both appUrl cases and both internetOrigin cases', () => {
    expect(
      v.safeParse(SystemHealthResponseSchema, { webhookSecretConfigured: true, appUrl: 'https://example.test', internetOrigin: null }).success,
    ).toBe(true);
    expect(
      v.safeParse(SystemHealthResponseSchema, { webhookSecretConfigured: false, appUrl: null, internetOrigin: 'https://hooks.example.test' }).success,
    ).toBe(true);
  });

  it('rejects a missing field, internetOrigin included', () => {
    expect(v.safeParse(SystemHealthResponseSchema, { webhookSecretConfigured: true, internetOrigin: null }).success).toBe(false);
    expect(v.safeParse(SystemHealthResponseSchema, { appUrl: null, internetOrigin: null }).success).toBe(false);
    expect(v.safeParse(SystemHealthResponseSchema, { webhookSecretConfigured: true, appUrl: null }).success).toBe(false);
  });

  it('rejects a non-string, non-null internetOrigin', () => {
    expect(
      v.safeParse(SystemHealthResponseSchema, { webhookSecretConfigured: true, appUrl: null, internetOrigin: 5 }).success,
    ).toBe(false);
  });

  it('rejects an extra key', () => {
    expect(
      v.safeParse(SystemHealthResponseSchema, { webhookSecretConfigured: true, appUrl: null, internetOrigin: null, extra: 1 }).success,
    ).toBe(false);
  });
});
