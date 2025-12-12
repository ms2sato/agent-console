import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getChildProcessEnv } from '../env-filter.js';

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
    it('should set NODE_ENV to empty string to override bun-pty inheritance', () => {
      process.env.NODE_ENV = 'production';
      process.env.HOME = '/home/test';

      const childEnv = getChildProcessEnv();

      // bun-pty merges env with parent, so we set to empty string to override
      expect(childEnv.NODE_ENV).toBe('');
      expect(childEnv.HOME).toBe('/home/test');
    });

    it('should set PORT to empty string to override bun-pty inheritance', () => {
      process.env.PORT = '3000';
      process.env.PATH = '/usr/bin';

      const childEnv = getChildProcessEnv();

      expect(childEnv.PORT).toBe('');
      expect(childEnv.PATH).toBe('/usr/bin');
    });

    it('should set HOST to empty string to override bun-pty inheritance', () => {
      process.env.HOST = '0.0.0.0';
      process.env.USER = 'testuser';

      const childEnv = getChildProcessEnv();

      expect(childEnv.HOST).toBe('');
      expect(childEnv.USER).toBe('testuser');
    });

    it('should set all blocked variables to empty string', () => {
      process.env.NODE_ENV = 'production';
      process.env.PORT = '6340';
      process.env.HOST = 'localhost';
      process.env.HOME = '/home/test';
      process.env.SHELL = '/bin/zsh';

      const childEnv = getChildProcessEnv();

      expect(childEnv.NODE_ENV).toBe('');
      expect(childEnv.PORT).toBe('');
      expect(childEnv.HOST).toBe('');
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
});
