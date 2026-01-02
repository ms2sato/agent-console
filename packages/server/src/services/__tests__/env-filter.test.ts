import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getChildProcessEnv, getUnsetEnvPrefix, BLOCKED_ENV_VARS } from '../env-filter.js';

describe('env-filter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original process.env
    process.env = originalEnv;
  });

  describe('getChildProcessEnv', () => {
    it('should exclude NODE_ENV from child process env', () => {
      process.env.NODE_ENV = 'production';
      process.env.HOME = '/home/test';

      const childEnv = getChildProcessEnv();

      // Blocked vars are excluded from env object (actual removal via unset prefix)
      expect('NODE_ENV' in childEnv).toBe(false);
      expect(childEnv.HOME).toBe('/home/test');
    });

    it('should exclude PORT from child process env', () => {
      process.env.PORT = '3000';
      process.env.PATH = '/usr/bin';

      const childEnv = getChildProcessEnv();

      expect('PORT' in childEnv).toBe(false);
      expect(childEnv.PATH).toBe('/usr/bin');
    });

    it('should exclude HOST from child process env', () => {
      process.env.HOST = '0.0.0.0';
      process.env.USER = 'testuser';

      const childEnv = getChildProcessEnv();

      expect('HOST' in childEnv).toBe(false);
      expect(childEnv.USER).toBe('testuser');
    });

    it('should exclude all blocked variables from child process env', () => {
      process.env.NODE_ENV = 'production';
      process.env.PORT = '6340';
      process.env.HOST = 'localhost';
      process.env.HOME = '/home/test';
      process.env.SHELL = '/bin/zsh';

      const childEnv = getChildProcessEnv();

      expect('NODE_ENV' in childEnv).toBe(false);
      expect('PORT' in childEnv).toBe(false);
      expect('HOST' in childEnv).toBe(false);
      expect(childEnv.HOME).toBe('/home/test');
      expect(childEnv.SHELL).toBe('/bin/zsh');
    });

    it('should pass through other environment variables unchanged', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.CUSTOM_VAR = 'custom-value';

      const childEnv = getChildProcessEnv();

      expect(childEnv.ANTHROPIC_API_KEY).toBe('test-key');
      expect(childEnv.CUSTOM_VAR).toBe('custom-value');
    });

    it('should not include undefined values', () => {
      // Ensure we start with a clean slate for this specific var
      delete process.env.UNDEFINED_VAR;

      const childEnv = getChildProcessEnv();

      expect('UNDEFINED_VAR' in childEnv).toBe(false);
    });

    it('should set color support environment variables for PTY', () => {
      const childEnv = getChildProcessEnv();

      expect(childEnv.TERM).toBe('xterm-256color');
      expect(childEnv.COLORTERM).toBe('truecolor');
      expect(childEnv.FORCE_COLOR).toBe('1');
    });

    it('should override existing TERM with xterm-256color', () => {
      process.env.TERM = 'dumb';

      const childEnv = getChildProcessEnv();

      expect(childEnv.TERM).toBe('xterm-256color');
    });
  });

  describe('getUnsetEnvPrefix', () => {
    it('should return unset command with all blocked variables', () => {
      const prefix = getUnsetEnvPrefix();

      // Verify it starts with "unset " and ends with "; "
      expect(prefix.startsWith('unset ')).toBe(true);
      expect(prefix.endsWith('; ')).toBe(true);

      // Verify all blocked vars are included
      for (const varName of BLOCKED_ENV_VARS) {
        expect(prefix).toContain(varName);
      }
    });

    it('should include all blocked env vars in the unset command', () => {
      const prefix = getUnsetEnvPrefix();

      // Parse the variables from the unset command
      const varsPart = prefix.slice('unset '.length, -'; '.length);
      const unsetVars = varsPart.split(' ');

      // Should have the same number of variables as BLOCKED_ENV_VARS
      expect(unsetVars.length).toBe(BLOCKED_ENV_VARS.length);

      // Each blocked var should be in the unset command
      for (const blockedVar of BLOCKED_ENV_VARS) {
        expect(unsetVars).toContain(blockedVar);
      }
    });

    it('should produce a valid shell command format', () => {
      const prefix = getUnsetEnvPrefix();

      // The format should be "unset VAR1 VAR2 VAR3; "
      // This regex validates the format
      const validFormat = /^unset [A-Z_]+( [A-Z_]+)*; $/;
      expect(validFormat.test(prefix)).toBe(true);
    });
  });
});
