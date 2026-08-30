import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveAuthCookieSecure,
  shouldWarnInsecureAuthCookie,
  shouldLogUnconfiguredPublicOrigin,
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

    it('should default EMBEDDED_AGENT_IDLE_EVICTION_MS to 30 minutes when not set', async () => {
      delete process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS;

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.EMBEDDED_AGENT_IDLE_EVICTION_MS).toBe(30 * 60 * 1000);
    });

    it('should use an explicit EMBEDDED_AGENT_IDLE_EVICTION_MS value', async () => {
      process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS = '60000';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.EMBEDDED_AGENT_IDLE_EVICTION_MS).toBe(60000);
    });

    it('should keep EMBEDDED_AGENT_IDLE_EVICTION_MS=0 as the disabled value', async () => {
      process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS = '0';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.EMBEDDED_AGENT_IDLE_EVICTION_MS).toBe(0);
    });

    it('should fall back to the default for an unparseable EMBEDDED_AGENT_IDLE_EVICTION_MS', async () => {
      // A typo must not silently disable idle eviction: NaN would compare
      // false against every bound and behave exactly like 0.
      process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS = 'thirty minutes';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.EMBEDDED_AGENT_IDLE_EVICTION_MS).toBe(30 * 60 * 1000);
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

    it("should default PTY_PROVIDER to 'bun-terminal' when not set", async () => {
      delete process.env.PTY_PROVIDER;
      const { serverConfig } = await importServerConfig();
      expect(serverConfig.PTY_PROVIDER).toBe('bun-terminal');
    });

    it("should accept PTY_PROVIDER='bun-terminal'", async () => {
      process.env.PTY_PROVIDER = 'bun-terminal';
      const { serverConfig } = await importServerConfig();
      expect(serverConfig.PTY_PROVIDER).toBe('bun-terminal');
    });

    it("should accept explicit PTY_PROVIDER='bun-pty' override (rollback escape hatch)", async () => {
      process.env.PTY_PROVIDER = 'bun-pty';
      const { serverConfig } = await importServerConfig();
      expect(serverConfig.PTY_PROVIDER).toBe('bun-pty');
    });

    it('should throw for invalid PTY_PROVIDER value', async () => {
      process.env.PTY_PROVIDER = 'wterm';
      await expect(importServerConfig()).rejects.toThrow(
        "Invalid PTY_PROVIDER: 'wterm'. Must be 'bun-pty' or 'bun-terminal'."
      );
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
        /Invalid AUTH_COOKIE_SECURE: Expected 'true', 'false', or unset, got: '1'/
      );
    });

    it('should default AGENT_CONSOLE_PUBLIC_ORIGIN to undefined when not set', async () => {
      delete process.env.AGENT_CONSOLE_PUBLIC_ORIGIN;

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_PUBLIC_ORIGIN).toBeUndefined();
    });

    it('should treat empty AGENT_CONSOLE_PUBLIC_ORIGIN as unset (operator-friendly)', async () => {
      process.env.AGENT_CONSOLE_PUBLIC_ORIGIN = '';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_PUBLIC_ORIGIN).toBeUndefined();
    });

    it('should trim whitespace around a configured AGENT_CONSOLE_PUBLIC_ORIGIN', async () => {
      process.env.AGENT_CONSOLE_PUBLIC_ORIGIN = '  http://192.168.1.12:6340  ';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_PUBLIC_ORIGIN).toBe('http://192.168.1.12:6340');
    });

    it('should expose AGENT_CONSOLE_PUBLIC_ORIGIN when set to a non-empty string', async () => {
      process.env.AGENT_CONSOLE_PUBLIC_ORIGIN = 'http://localhost:3457';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_PUBLIC_ORIGIN).toBe('http://localhost:3457');
    });

    it('should strip a trailing slash from AGENT_CONSOLE_PUBLIC_ORIGIN (avoids a double slash when concatenated with a leading-slash path)', async () => {
      process.env.AGENT_CONSOLE_PUBLIC_ORIGIN = 'http://localhost:6340/';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_PUBLIC_ORIGIN).toBe('http://localhost:6340');
    });

    it('should strip multiple trailing slashes from AGENT_CONSOLE_PUBLIC_ORIGIN', async () => {
      process.env.AGENT_CONSOLE_PUBLIC_ORIGIN = 'http://localhost:6340///';

      const { serverConfig } = await importServerConfig();

      expect(serverConfig.AGENT_CONSOLE_PUBLIC_ORIGIN).toBe('http://localhost:6340');
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

  describe('shouldLogUnconfiguredPublicOrigin', () => {
    it('unset -> true (deliberately mode-independent, no AUTH_MODE input)', () => {
      expect(shouldLogUnconfiguredPublicOrigin({ AGENT_CONSOLE_PUBLIC_ORIGIN: undefined })).toBe(true);
    });

    it('configured -> false', () => {
      expect(
        shouldLogUnconfiguredPublicOrigin({ AGENT_CONSOLE_PUBLIC_ORIGIN: 'http://localhost:3457' })
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

describe('WORKER_OUTPUT_RESTORE_MAX_BYTES', () => {
  it('is generous by default, because it only bounds a history with no boundary at all', async () => {
    const { serverConfig } = await importServerConfig();
    // The walk-back stops at a boundary or the true start in the ordinary
    // case, so this ceiling is reached only by a pathological history. Set it
    // small and ordinary workers would restore partially for no reason.
    expect(serverConfig.WORKER_OUTPUT_RESTORE_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it('is larger than the live-window size, so the walk can always reach past one rotation', async () => {
    const { serverConfig } = await importServerConfig();
    // A ceiling at or below `WORKER_OUTPUT_FILE_MAX_SIZE` would make the cap
    // fire on the first archived segment of every rotated worker -- turning
    // the ordinary case into the pathological one.
    expect(serverConfig.WORKER_OUTPUT_RESTORE_MAX_BYTES).toBeGreaterThan(
      serverConfig.WORKER_OUTPUT_FILE_MAX_SIZE,
    );
  });
});
});
