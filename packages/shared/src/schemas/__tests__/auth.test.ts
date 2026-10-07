import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { LoginRequestSchema, ConfigResponseSchema, MePreferencesSchema } from '../auth';

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

describe('ConfigResponseSchema', () => {
  const validSample = {
    homeDir: '/home/alice',
    capabilities: {
      vscode: true,
      vscodeOpenMode: 'local-spawn',
      vscodeRemoteHost: null,
    },
    serverPid: 1234,
    serverPort: 3457,
    authMode: 'none',
    sharedAccountsAvailable: false,
    deployedSha: null,
  };

  it('accepts a valid full sample object with deployedSha: null', () => {
    const result = v.safeParse(ConfigResponseSchema, validSample);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.deployedSha).toBeNull();
    }
  });

  it('accepts a valid full sample object with deployedSha as a string', () => {
    const result = v.safeParse(ConfigResponseSchema, { ...validSample, deployedSha: 'abc123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.deployedSha).toBe('abc123');
    }
  });

  it('rejects deployedSha of the wrong type (number)', () => {
    const result = v.safeParse(ConfigResponseSchema, { ...validSample, deployedSha: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a missing deployedSha key entirely (required, not optional)', () => {
    const { deployedSha: _omit, ...withoutDeployedSha } = validSample;
    const result = v.safeParse(ConfigResponseSchema, withoutDeployedSha);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(ConfigResponseSchema, { ...validSample, unexpectedField: 'leaked' });
    expect(result.success).toBe(false);
  });
});

describe('MePreferencesSchema', () => {
  it('accepts disableClaudeAiConnectors: true', () => {
    const result = v.safeParse(MePreferencesSchema, { disableClaudeAiConnectors: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.disableClaudeAiConnectors).toBe(true);
    }
  });

  it('accepts disableClaudeAiConnectors: false', () => {
    const result = v.safeParse(MePreferencesSchema, { disableClaudeAiConnectors: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.disableClaudeAiConnectors).toBe(false);
    }
  });

  it('rejects a missing disableClaudeAiConnectors key', () => {
    const result = v.safeParse(MePreferencesSchema, {});
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean disableClaudeAiConnectors value', () => {
    const result = v.safeParse(MePreferencesSchema, { disableClaudeAiConnectors: 'true' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract, and never a caller-supplied id/userId)', () => {
    const result = v.safeParse(MePreferencesSchema, {
      disableClaudeAiConnectors: true,
      userId: 'user-should-not-be-accepted',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'userId')).toBe(true);
    }
  });
});
