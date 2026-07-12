import { describe, it, expect } from 'bun:test';
import { buildBashEnv } from '../env-cleaner.js';

describe('buildBashEnv', () => {
  it('strips AGENT_CONSOLE_*-prefixed keys', () => {
    const result = buildBashEnv({
      AGENT_CONSOLE_MCP_TOKEN: 'secret-token',
      AGENT_CONSOLE_HOME: '/some/path',
      PATH: '/usr/bin:/bin',
    });

    expect(result).toEqual({ PATH: '/usr/bin:/bin' });
  });

  it('passes through non-prefixed keys unchanged', () => {
    const result = buildBashEnv({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' });

    expect(result).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' });
  });

  it('drops keys whose value is undefined', () => {
    const result = buildBashEnv({ PATH: '/usr/bin', UNDEFINED_KEY: undefined });

    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('produces an empty output for an empty input', () => {
    const result = buildBashEnv({});

    expect(result).toEqual({});
  });
});
