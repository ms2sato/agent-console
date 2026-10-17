import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import type { AuthUser, LoginResponse, UpdateUserPreferencesResponse } from '../../types/auth';
import {
  LoginRequestSchema,
  ConfigResponseSchema,
  MePreferencesSchema,
  AuthUserSchema,
  CurrentUserResponseSchema,
  LoginResponseSchema,
  UpdateUserPreferencesResponseSchema,
} from '../auth';

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
    sharedAccountsEnvVarIgnored: false,
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

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The hand-written `AuthUser` domain type and the wire schema must stay one shape.
export type _AuthUserMatchesSchema = Assert<Equals<AuthUser, v.InferOutput<typeof AuthUserSchema>>>;

describe('CurrentUserResponseSchema', () => {
  const user = { id: 'u1', username: 'alice', homeDir: '/home/alice' };

  it('accepts the unauthenticated body (user null, no preferences)', () => {
    expect(v.safeParse(CurrentUserResponseSchema, { user: null }).success).toBe(true);
  });

  it('accepts a user with preferences', () => {
    expect(
      v.safeParse(CurrentUserResponseSchema, { user, preferences: { disableClaudeAiConnectors: true } }).success,
    ).toBe(true);
  });

  it('rejects a missing user key, an unknown user field and an extra top-level key', () => {
    expect(v.safeParse(CurrentUserResponseSchema, {}).success).toBe(false);
    expect(v.safeParse(CurrentUserResponseSchema, { user: { ...user, extra: 1 } }).success).toBe(false);
    expect(v.safeParse(CurrentUserResponseSchema, { user: null, extra: 1 }).success).toBe(false);
  });
});

// `LoginResponse` / `UpdateUserPreferencesResponse` stay hand-written interfaces the server imports;
// these pins fix each schema's output to its interface exactly. `Assert<Equals<...>>` fails `tsc`
// (TS2344) under drift in either direction.
export type _LoginResponseIsExact = Assert<Equals<v.InferOutput<typeof LoginResponseSchema>, LoginResponse>>;
export type _UpdateUserPreferencesResponseIsExact = Assert<
  Equals<v.InferOutput<typeof UpdateUserPreferencesResponseSchema>, UpdateUserPreferencesResponse>
>;

describe('LoginResponseSchema', () => {
  const user = { id: 'u1', username: 'alice', homeDir: '/home/alice' };

  it('accepts { user }', () => {
    expect(v.safeParse(LoginResponseSchema, { user }).success).toBe(true);
  });

  it('rejects an extra field on the envelope and on the user', () => {
    expect(v.safeParse(LoginResponseSchema, { user, extra: 1 }).success).toBe(false);
    expect(v.safeParse(LoginResponseSchema, { user: { ...user, extra: 1 } }).success).toBe(false);
  });

  it('rejects a missing or null user', () => {
    expect(v.safeParse(LoginResponseSchema, {}).success).toBe(false);
    expect(v.safeParse(LoginResponseSchema, { user: null }).success).toBe(false);
  });
});

describe('UpdateUserPreferencesResponseSchema', () => {
  const user = { id: 'u1', username: 'alice', homeDir: '/home/alice' };
  const preferences = { disableClaudeAiConnectors: true };

  it('accepts { user, preferences }', () => {
    expect(v.safeParse(UpdateUserPreferencesResponseSchema, { user, preferences }).success).toBe(true);
  });

  it('rejects an extra field on the envelope and on the preferences', () => {
    expect(v.safeParse(UpdateUserPreferencesResponseSchema, { user, preferences, extra: 1 }).success).toBe(false);
    expect(
      v.safeParse(UpdateUserPreferencesResponseSchema, { user, preferences: { ...preferences, extra: 1 } }).success,
    ).toBe(false);
  });

  it('rejects a dropped preferences (unlike the current-user response) and a null user', () => {
    expect(v.safeParse(UpdateUserPreferencesResponseSchema, { user }).success).toBe(false);
    expect(v.safeParse(UpdateUserPreferencesResponseSchema, { user: null, preferences }).success).toBe(false);
  });
});
