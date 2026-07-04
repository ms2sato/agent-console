import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { LoginRequestSchema } from '../auth';

describe('LoginRequestSchema', () => {
  it('should accept a valid login request', () => {
    const result = v.safeParse(LoginRequestSchema, {
      username: 'alice',
      password: 's3cret',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.username).toBe('alice');
      expect(result.output.password).toBe('s3cret');
    }
  });

  it('should reject a missing username', () => {
    const result = v.safeParse(LoginRequestSchema, {
      password: 's3cret',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an empty username', () => {
    const result = v.safeParse(LoginRequestSchema, {
      username: '',
      password: 's3cret',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a missing password', () => {
    const result = v.safeParse(LoginRequestSchema, {
      username: 'alice',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an empty password', () => {
    const result = v.safeParse(LoginRequestSchema, {
      username: 'alice',
      password: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(LoginRequestSchema, {
      username: 'alice',
      password: 's3cret',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });
});
