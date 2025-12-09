import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    it('should exclude NODE_ENV from child process environment', () => {
      process.env.NODE_ENV = 'production';
      process.env.HOME = '/home/test';

      const childEnv = getChildProcessEnv();

      expect(childEnv.NODE_ENV).toBeUndefined();
      expect(childEnv.HOME).toBe('/home/test');
    });

    it('should exclude PORT from child process environment', () => {
      process.env.PORT = '3000';
      process.env.PATH = '/usr/bin';

      const childEnv = getChildProcessEnv();

      expect(childEnv.PORT).toBeUndefined();
      expect(childEnv.PATH).toBe('/usr/bin');
    });

    it('should exclude HOST from child process environment', () => {
      process.env.HOST = '0.0.0.0';
      process.env.USER = 'testuser';

      const childEnv = getChildProcessEnv();

      expect(childEnv.HOST).toBeUndefined();
      expect(childEnv.USER).toBe('testuser');
    });

    it('should exclude all blocked variables at once', () => {
      process.env.NODE_ENV = 'production';
      process.env.PORT = '6340';
      process.env.HOST = 'localhost';
      process.env.HOME = '/home/test';
      process.env.SHELL = '/bin/zsh';

      const childEnv = getChildProcessEnv();

      expect(childEnv.NODE_ENV).toBeUndefined();
      expect(childEnv.PORT).toBeUndefined();
      expect(childEnv.HOST).toBeUndefined();
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
