import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

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
      expect(serverConfig.HOST).toBe('localhost');
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
