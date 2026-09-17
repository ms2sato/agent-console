import { describe, it, expect } from 'bun:test';
import { AGENT_CONSOLE_IDENTITY_ENV_KEYS } from '@agent-console/shared';
import { buildBashEnv } from '../env-cleaner.js';

// Issue #1694 (C4): buildBashEnv is a key ALLOWLIST for the AGENT_CONSOLE_*
// namespace -- the six identity keys pass through, every other
// AGENT_CONSOLE_* key is stripped. Reach measured per test in its own
// comment; the two mutations tried were (m1) reverting the filter to the
// pre-#1694 blanket `key.startsWith('AGENT_CONSOLE_')` strip and (m2)
// dropping the strip entirely (pass everything through).
describe('buildBashEnv', () => {
  it('passes every identity key through with its value (m1 fails: all six stripped)', () => {
    const source: Record<string, string> = {};
    for (const key of AGENT_CONSOLE_IDENTITY_ENV_KEYS) source[key] = `value-of-${key}`;
    source.PATH = '/usr/bin:/bin';

    const result = buildBashEnv(source);

    for (const key of AGENT_CONSOLE_IDENTITY_ENV_KEYS) {
      expect(result[key]).toBe(`value-of-${key}`);
    }
    expect(result.PATH).toBe('/usr/bin:/bin');
  });

  it('strips every OTHER AGENT_CONSOLE_*-prefixed key (m2 fails: MCP_TOKEN / HOME / MCP_TOKEN_FILE leak)', () => {
    const result = buildBashEnv({
      AGENT_CONSOLE_MCP_TOKEN: 'secret-token',
      AGENT_CONSOLE_MCP_TOKEN_FILE: '/run/token',
      AGENT_CONSOLE_HOME: '/some/path',
      AGENT_CONSOLE_PUBLIC_ORIGIN: 'http://host:6340',
      AGENT_CONSOLE_SESSION_ID: 'sess-1',
      PATH: '/usr/bin:/bin',
    });

    expect(result).toEqual({ AGENT_CONSOLE_SESSION_ID: 'sess-1', PATH: '/usr/bin:/bin' });
  });

  it('is an exact-key allowlist, not a prefix match: a key that merely starts with an identity key is stripped', () => {
    // `AGENT_CONSOLE_SESSION_ID_X` is not an identity key. A `startsWith`
    // allowlist would let it through; the exact-membership check does not.
    const result = buildBashEnv({
      AGENT_CONSOLE_SESSION_ID_X: 'not-identity',
      AGENT_CONSOLE_SESSION_ID: 'sess-1',
    });

    expect(result).toEqual({ AGENT_CONSOLE_SESSION_ID: 'sess-1' });
  });

  it('passes through non-prefixed keys unchanged', () => {
    const result = buildBashEnv({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' });

    expect(result).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' });
  });

  it('drops keys whose value is undefined, identity keys included', () => {
    const result = buildBashEnv({ PATH: '/usr/bin', UNDEFINED_KEY: undefined, AGENT_CONSOLE_WORKER_ID: undefined });

    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('produces an empty output for an empty input', () => {
    const result = buildBashEnv({});

    expect(result).toEqual({});
  });
});
