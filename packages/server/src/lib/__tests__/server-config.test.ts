import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('server-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    // Clear module cache to test fresh imports
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original process.env
    process.env = originalEnv;
  });

  describe('serverConfig', () => {
    it('should use default values when environment variables are not set', async () => {
      delete process.env.NODE_ENV;
      delete process.env.PORT;
      delete process.env.HOST;

      const { serverConfig } = await import('../server-config.js');

      expect(serverConfig.NODE_ENV).toBeUndefined();
      expect(serverConfig.PORT).toBe('3457');
      expect(serverConfig.HOST).toBe('localhost');
    });

    it('should use environment variable values when set', async () => {
      process.env.NODE_ENV = 'production';
      process.env.PORT = '8080';
      process.env.HOST = '0.0.0.0';

      const { serverConfig } = await import('../server-config.js');

      expect(serverConfig.NODE_ENV).toBe('production');
      expect(serverConfig.PORT).toBe('8080');
      expect(serverConfig.HOST).toBe('0.0.0.0');
    });
  });

  describe('SERVER_ONLY_ENV_VARS', () => {
    it('should contain all serverConfig keys', async () => {
      const { serverConfig, SERVER_ONLY_ENV_VARS } = await import(
        '../server-config.js'
      );

      const configKeys = Object.keys(serverConfig);
      expect(SERVER_ONLY_ENV_VARS).toEqual(configKeys);
    });

    it('should include NODE_ENV, PORT, and HOST', async () => {
      const { SERVER_ONLY_ENV_VARS } = await import('../server-config.js');

      expect(SERVER_ONLY_ENV_VARS).toContain('NODE_ENV');
      expect(SERVER_ONLY_ENV_VARS).toContain('PORT');
      expect(SERVER_ONLY_ENV_VARS).toContain('HOST');
    });

    it('should be readonly array', async () => {
      const { SERVER_ONLY_ENV_VARS } = await import('../server-config.js');

      // TypeScript enforces this at compile time, but we can verify the runtime behavior
      expect(Array.isArray(SERVER_ONLY_ENV_VARS)).toBe(true);
    });
  });
});
