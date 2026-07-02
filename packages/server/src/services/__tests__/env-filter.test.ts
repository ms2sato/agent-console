import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  getChildProcessEnv,
  getUnsetEnvPrefix,
  filterRepositoryEnvVars,
  isInheritedClaudeSessionVar,
} from '../env-filter.js';
import { SERVER_ONLY_ENV_VARS } from '../../lib/server-config.js';

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
      // FORCE_COLOR=3 requests truecolor (24-bit) output from Node-based agents
      // and chalk-style libraries; matches the truecolor capability that xterm.js
      // renders end-to-end.
      expect(childEnv.FORCE_COLOR).toBe('3');
    });

    it('should override existing TERM with xterm-256color', () => {
      process.env.TERM = 'dumb';

      const childEnv = getChildProcessEnv();

      expect(childEnv.TERM).toBe('xterm-256color');
    });

    it('should exclude inherited Claude Code session vars (Issue #949)', () => {
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE_SESSION_ID = 'parent-id';
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

      const childEnv = getChildProcessEnv();

      expect('CLAUDECODE' in childEnv).toBe(false);
      expect('CLAUDE_CODE_SESSION_ID' in childEnv).toBe(false);
      expect('CLAUDE_CODE_ENTRYPOINT' in childEnv).toBe(false);
    });

    it('should keep vars that only resemble Claude Code session vars', () => {
      // Prefix rule is exactly `CLAUDE_CODE_`; `CLAUDE_CODEX` must NOT match,
      // and the exact name is `CLAUDECODE`, so `MY_CLAUDECODE` must NOT match.
      process.env.CLAUDE_CODEX = 'keep-me';
      process.env.MY_CLAUDECODE = 'keep-me-too';
      process.env.CLAUDE_CODE_X = 'strip-me';

      const childEnv = getChildProcessEnv();

      expect(childEnv.CLAUDE_CODEX).toBe('keep-me');
      expect(childEnv.MY_CLAUDECODE).toBe('keep-me-too');
      expect('CLAUDE_CODE_X' in childEnv).toBe(false);
    });
  });

  describe('isInheritedClaudeSessionVar', () => {
    it('should match CLAUDECODE and CLAUDE_CODE_* names', () => {
      expect(isInheritedClaudeSessionVar('CLAUDECODE')).toBe(true);
      expect(isInheritedClaudeSessionVar('CLAUDE_CODE_SESSION_ID')).toBe(true);
      expect(isInheritedClaudeSessionVar('CLAUDE_CODE_ENTRYPOINT')).toBe(true);
      expect(isInheritedClaudeSessionVar('CLAUDE_CODE_X')).toBe(true);
    });

    it('should not match near-miss names', () => {
      // `CLAUDE_CODEX` shares the `CLAUDE_CODE` stem but not the `CLAUDE_CODE_`
      // prefix; `MY_CLAUDECODE` is not the exact `CLAUDECODE` name.
      expect(isInheritedClaudeSessionVar('CLAUDE_CODEX')).toBe(false);
      expect(isInheritedClaudeSessionVar('MY_CLAUDECODE')).toBe(false);
      expect(isInheritedClaudeSessionVar('CLAUDE_API_KEY')).toBe(false);
      expect(isInheritedClaudeSessionVar('ANTHROPIC_API_KEY')).toBe(false);
    });
  });

  describe('getUnsetEnvPrefix', () => {
    it('should return unset command with all blocked variables', () => {
      const prefix = getUnsetEnvPrefix();

      // Verify it starts with "unset " and ends with "; "
      expect(prefix.startsWith('unset ')).toBe(true);
      expect(prefix.endsWith('; ')).toBe(true);

      // Verify all blocked vars are included
      for (const varName of SERVER_ONLY_ENV_VARS) {
        expect(prefix).toContain(varName);
      }
    });

    it('should include all blocked env vars in the unset command', () => {
      // Remove any inherited Claude Code session vars so this baseline test
      // asserts exactly the blocked-var set (Issue #949: getUnsetEnvPrefix
      // also unsets CLAUDE_CODE_* dynamically when present).
      for (const key of Object.keys(process.env)) {
        if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
          delete process.env[key];
        }
      }

      const prefix = getUnsetEnvPrefix();

      // Parse the variables from the unset command
      const varsPart = prefix.slice('unset '.length, -'; '.length);
      const unsetVars = varsPart.split(' ');

      // Should have the same number of variables as SERVER_ONLY_ENV_VARS
      expect(unsetVars.length).toBe(SERVER_ONLY_ENV_VARS.length);

      // Each blocked var should be in the unset command
      for (const blockedVar of SERVER_ONLY_ENV_VARS) {
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

    it('should dynamically unset inherited Claude Code session vars (Issue #949)', () => {
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE_SESSION_ID = 'parent-id';

      const prefix = getUnsetEnvPrefix();

      expect(prefix).toContain('CLAUDECODE');
      expect(prefix).toContain('CLAUDE_CODE_SESSION_ID');
    });

    it('should not include a var that only resembles a Claude Code session var', () => {
      // Remove any real inherited session vars, then add near-miss names.
      for (const key of Object.keys(process.env)) {
        if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
          delete process.env[key];
        }
      }
      process.env.CLAUDE_CODEX = 'x';
      process.env.MY_CLAUDECODE = 'y';

      const prefix = getUnsetEnvPrefix();

      // Whole-word check via the space/boundary-delimited unset list.
      const unsetVars = prefix.slice('unset '.length, -'; '.length).split(' ');
      expect(unsetVars).not.toContain('CLAUDE_CODEX');
      expect(unsetVars).not.toContain('MY_CLAUDECODE');
    });

    it('should equal blocked-only behavior when no Claude Code session vars are set', () => {
      for (const key of Object.keys(process.env)) {
        if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
          delete process.env[key];
        }
      }

      const prefix = getUnsetEnvPrefix();

      expect(prefix).toBe(`unset ${SERVER_ONLY_ENV_VARS.join(' ')}; `);
    });
  });

  describe('filterRepositoryEnvVars', () => {
    it('should pass through normal environment variables', () => {
      const input = {
        API_KEY: 'test-key',
        DEBUG: 'true',
        CUSTOM_VAR: 'custom-value',
      };

      const result = filterRepositoryEnvVars(input);

      expect(result).toEqual(input);
    });

    it('should filter out PATH', () => {
      const input = {
        PATH: '/malicious/path',
        API_KEY: 'test-key',
      };

      const result = filterRepositoryEnvVars(input);

      expect(result).toEqual({ API_KEY: 'test-key' });
    });

    it('should filter out HOME', () => {
      const input = {
        HOME: '/fake/home',
        API_KEY: 'test-key',
      };

      const result = filterRepositoryEnvVars(input);

      expect(result).toEqual({ API_KEY: 'test-key' });
    });

    it('should filter out LD_PRELOAD (security-sensitive)', () => {
      const input = {
        LD_PRELOAD: '/malicious/lib.so',
        API_KEY: 'test-key',
      };

      const result = filterRepositoryEnvVars(input);

      expect(result).toEqual({ API_KEY: 'test-key' });
    });

    it('should filter out DYLD_INSERT_LIBRARIES (macOS security-sensitive)', () => {
      const input = {
        DYLD_INSERT_LIBRARIES: '/malicious/lib.dylib',
        API_KEY: 'test-key',
      };

      const result = filterRepositoryEnvVars(input);

      expect(result).toEqual({ API_KEY: 'test-key' });
    });

    it('should filter out all protected variables', () => {
      const input = {
        // Security-sensitive
        LD_PRELOAD: '/malicious/lib.so',
        LD_LIBRARY_PATH: '/malicious/path',
        DYLD_INSERT_LIBRARIES: '/malicious/lib.dylib',
        DYLD_LIBRARY_PATH: '/malicious/path',
        DYLD_FRAMEWORK_PATH: '/malicious/path',
        // System-critical
        PATH: '/malicious/path',
        HOME: '/fake/home',
        USER: 'fake-user',
        SHELL: '/malicious/shell',
        TERM: 'dumb',
        COLORTERM: 'false',
        // Should be kept
        API_KEY: 'test-key',
        DEBUG: 'true',
      };

      const result = filterRepositoryEnvVars(input);

      expect(result).toEqual({
        API_KEY: 'test-key',
        DEBUG: 'true',
      });
    });

    it('should return empty object for empty input', () => {
      const result = filterRepositoryEnvVars({});

      expect(result).toEqual({});
    });

    it('should return empty object if all vars are protected', () => {
      const input = {
        PATH: '/malicious/path',
        HOME: '/fake/home',
      };

      const result = filterRepositoryEnvVars(input);

      expect(result).toEqual({});
    });
  });
});
