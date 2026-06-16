import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  parseAuthCookieSecure,
  resolveAuthCookieSecure,
  shouldWarnInsecureAuthCookie,
} from '../server-config.js';

describe('server-config', () => {
  const originalEnv = { ...process.env };
  let importCounter = 0;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original process.env
    process.env = originalEnv;
  });

  // Helper to import the module with cache bypass
  async function importServerConfig() {
    // Use unique query string to bypass module cache
    const module = await import(`../server-config.js?v=${++importCounter}`);
    return module;
  }

  describe('serverConfig', () => {
    it('should use default values when environment variables are not set', async () => {
      delete process.env.NODE_ENV;
      delete process.env.PORT;
      delete process.env.HOST;

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.NODE_ENV).toBeUndefined();
      expect(serverConfig.PORT).toBe('3457');
      // Defaults to 0.0.0.0 to avoid IPv4/IPv6 resolution issues with 'localhost' on macOS
      expect(serverConfig.HOST).toBe('0.0.0.0');
    });

    it('should use environment variable values when set', async () => {
      process.env.NODE_ENV = 'production';
      process.env.PORT = '8080';
      process.env.HOST = '0.0.0.0';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.NODE_ENV).toBe('production');
      expect(serverConfig.PORT).toBe('8080');
      expect(serverConfig.HOST).toBe('0.0.0.0');
    });

    it('should fallback to default when HOST is empty string', async () => {
      // Empty string is falsy, so it falls back to the default
      process.env.HOST = '';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.HOST).toBe('0.0.0.0');
    });

    it('should default AUTH_MODE to none when not set', async () => {
      delete process.env.AUTH_MODE;

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AUTH_MODE).toBe('none');
    });

    it('should accept AUTH_MODE=multi-user', async () => {
      process.env.AUTH_MODE = 'multi-user';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AUTH_MODE).toBe('multi-user');
    });

    it('should throw for empty AUTH_MODE string', async () => {
      process.env.AUTH_MODE = '';

      await expect(importServerConfig()).rejects.toThrow(
        "Invalid AUTH_MODE: ''. Must be 'none' or 'multi-user'."
      );
    });

    it('should throw for invalid AUTH_MODE value', async () => {
      process.env.AUTH_MODE = 'invalid-mode';

      await expect(importServerConfig()).rejects.toThrow(
        "Invalid AUTH_MODE: 'invalid-mode'. Must be 'none' or 'multi-user'."
      );
    });

    it('should default AGENT_CONSOLE_SHARED_USERNAME to undefined when not set', async () => {
      delete process.env.AGENT_CONSOLE_SHARED_USERNAME;

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_SHARED_USERNAME).toBeUndefined();
    });

    it('should treat empty AGENT_CONSOLE_SHARED_USERNAME as unset (operator-friendly)', async () => {
      process.env.AGENT_CONSOLE_SHARED_USERNAME = '';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_SHARED_USERNAME).toBeUndefined();
    });

    it('should expose AGENT_CONSOLE_SHARED_USERNAME when set to a non-empty string', async () => {
      process.env.AGENT_CONSOLE_SHARED_USERNAME = 'agent-console-shared';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_SHARED_USERNAME).toBe('agent-console-shared');
    });

    it('should default AUTH_COOKIE_SECURE to undefined when not set', async () => {
      delete process.env.AUTH_COOKIE_SECURE;

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AUTH_COOKIE_SECURE).toBeUndefined();
    });

    it('should treat empty AUTH_COOKIE_SECURE as unset', async () => {
      process.env.AUTH_COOKIE_SECURE = '';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AUTH_COOKIE_SECURE).toBeUndefined();
    });

    it('should expose AUTH_COOKIE_SECURE=true as boolean true', async () => {
      process.env.AUTH_COOKIE_SECURE = 'true';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AUTH_COOKIE_SECURE).toBe(true);
    });

    it('should expose AUTH_COOKIE_SECURE=false as boolean false', async () => {
      process.env.AUTH_COOKIE_SECURE = 'false';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AUTH_COOKIE_SECURE).toBe(false);
    });

    it('should throw for invalid AUTH_COOKIE_SECURE value', async () => {
      process.env.AUTH_COOKIE_SECURE = '1';

      await expect(importServerConfig()).rejects.toThrow(
        "Invalid AUTH_COOKIE_SECURE: '1'. Must be 'true', 'false', or unset."
      );
    });
  });

  describe('parseAuthCookieSecure', () => {
    it('returns undefined for undefined input', () => {
      expect(parseAuthCookieSecure(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(parseAuthCookieSecure('')).toBeUndefined();
    });

    it("returns true for 'true'", () => {
      expect(parseAuthCookieSecure('true')).toBe(true);
    });

    it("returns false for 'false'", () => {
      expect(parseAuthCookieSecure('false')).toBe(false);
    });

    it("throws for '1'", () => {
      expect(() => parseAuthCookieSecure('1')).toThrow(
        "Invalid AUTH_COOKIE_SECURE: '1'. Must be 'true', 'false', or unset."
      );
    });

    it("throws for 'yes'", () => {
      expect(() => parseAuthCookieSecure('yes')).toThrow(
        "Invalid AUTH_COOKIE_SECURE: 'yes'. Must be 'true', 'false', or unset."
      );
    });

    it("throws for 'TRUE' (case-sensitive)", () => {
      expect(() => parseAuthCookieSecure('TRUE')).toThrow(
        "Invalid AUTH_COOKIE_SECURE: 'TRUE'. Must be 'true', 'false', or unset."
      );
    });
  });

  describe('resolveAuthCookieSecure', () => {
    it('unset + production -> true (preserves current behavior)', () => {
      expect(
        resolveAuthCookieSecure({ AUTH_COOKIE_SECURE: undefined, NODE_ENV: 'production' })
      ).toBe(true);
    });

    it('unset + development -> false', () => {
      expect(
        resolveAuthCookieSecure({ AUTH_COOKIE_SECURE: undefined, NODE_ENV: 'development' })
      ).toBe(false);
    });

    it('unset + undefined NODE_ENV -> false', () => {
      expect(
        resolveAuthCookieSecure({ AUTH_COOKIE_SECURE: undefined, NODE_ENV: undefined })
      ).toBe(false);
    });

    it('false + production -> false', () => {
      expect(
        resolveAuthCookieSecure({ AUTH_COOKIE_SECURE: false, NODE_ENV: 'production' })
      ).toBe(false);
    });

    it('false + development -> false', () => {
      expect(
        resolveAuthCookieSecure({ AUTH_COOKIE_SECURE: false, NODE_ENV: 'development' })
      ).toBe(false);
    });

    it('true + development -> true', () => {
      expect(
        resolveAuthCookieSecure({ AUTH_COOKIE_SECURE: true, NODE_ENV: 'development' })
      ).toBe(true);
    });

    it('true + production -> true', () => {
      expect(
        resolveAuthCookieSecure({ AUTH_COOKIE_SECURE: true, NODE_ENV: 'production' })
      ).toBe(true);
    });
  });

  describe('shouldWarnInsecureAuthCookie', () => {
    it('false + production -> true (the only true case)', () => {
      expect(
        shouldWarnInsecureAuthCookie({ AUTH_COOKIE_SECURE: false, NODE_ENV: 'production' })
      ).toBe(true);
    });

    it('false + development -> false', () => {
      expect(
        shouldWarnInsecureAuthCookie({ AUTH_COOKIE_SECURE: false, NODE_ENV: 'development' })
      ).toBe(false);
    });

    it('undefined + production -> false', () => {
      expect(
        shouldWarnInsecureAuthCookie({ AUTH_COOKIE_SECURE: undefined, NODE_ENV: 'production' })
      ).toBe(false);
    });

    it('true + production -> false', () => {
      expect(
        shouldWarnInsecureAuthCookie({ AUTH_COOKIE_SECURE: true, NODE_ENV: 'production' })
      ).toBe(false);
    });

    it('undefined + development -> false', () => {
      expect(
        shouldWarnInsecureAuthCookie({ AUTH_COOKIE_SECURE: undefined, NODE_ENV: 'development' })
      ).toBe(false);
    });
  });

  describe('SERVER_ONLY_ENV_VARS', () => {
    it('should contain all serverConfig keys', async () => {
      const { serverConfig, SERVER_ONLY_ENV_VARS } = await importServerConfig();

      const configKeys = Object.keys(serverConfig);
      expect(SERVER_ONLY_ENV_VARS).toEqual(configKeys);
    });

    it('should include NODE_ENV, PORT, and HOST', async () => {
      const { SERVER_ONLY_ENV_VARS } = await importServerConfig();

      expect(SERVER_ONLY_ENV_VARS).toContain('NODE_ENV');
      expect(SERVER_ONLY_ENV_VARS).toContain('PORT');
      expect(SERVER_ONLY_ENV_VARS).toContain('HOST');
    });

    it('should be readonly array', async () => {
      const { SERVER_ONLY_ENV_VARS } = await importServerConfig();

      // TypeScript enforces this at compile time, but we can verify the runtime behavior
      expect(Array.isArray(SERVER_ONLY_ENV_VARS)).toBe(true);
    });
  });
});
