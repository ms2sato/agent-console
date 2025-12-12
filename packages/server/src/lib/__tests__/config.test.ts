import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import { getConfigDir, getRepositoriesDir, getRepositoryDir, getServerPid } from '../config.js';

describe('config', () => {
  const originalEnv = process.env.AGENT_CONSOLE_HOME;

  beforeEach(() => {
    // Clear the env var to test default behavior
    delete process.env.AGENT_CONSOLE_HOME;
  });

  afterEach(() => {
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalEnv;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  describe('getConfigDir', () => {
    it('should return default path when AGENT_CONSOLE_HOME is not set', () => {
      delete process.env.AGENT_CONSOLE_HOME;

      const expected = path.join(os.homedir(), '.agent-console');
      expect(getConfigDir()).toBe(expected);
    });

    it('should return AGENT_CONSOLE_HOME when set', () => {
      process.env.AGENT_CONSOLE_HOME = '/custom/config/path';

      expect(getConfigDir()).toBe('/custom/config/path');
    });

    it('should return different paths for different AGENT_CONSOLE_HOME values', () => {
      process.env.AGENT_CONSOLE_HOME = '/path/one';
      expect(getConfigDir()).toBe('/path/one');

      process.env.AGENT_CONSOLE_HOME = '/path/two';
      expect(getConfigDir()).toBe('/path/two');
    });
  });

  describe('getServerPid', () => {
    it('should return current process PID', () => {
      expect(getServerPid()).toBe(process.pid);
      expect(typeof getServerPid()).toBe('number');
    });
  });

  describe('getRepositoriesDir', () => {
    it('should return repositories subdirectory of config dir', () => {
      delete process.env.AGENT_CONSOLE_HOME;

      const expected = path.join(os.homedir(), '.agent-console', 'repositories');
      expect(getRepositoriesDir()).toBe(expected);
    });

    it('should respect AGENT_CONSOLE_HOME', () => {
      process.env.AGENT_CONSOLE_HOME = '/custom/path';

      expect(getRepositoriesDir()).toBe('/custom/path/repositories');
    });
  });

  describe('getRepositoryDir', () => {
    it('should return repository-specific directory', () => {
      delete process.env.AGENT_CONSOLE_HOME;

      const expected = path.join(os.homedir(), '.agent-console', 'repositories', 'owner/repo');
      expect(getRepositoryDir('owner/repo')).toBe(expected);
    });

    it('should handle simple repo names', () => {
      process.env.AGENT_CONSOLE_HOME = '/config';

      expect(getRepositoryDir('my-repo')).toBe('/config/repositories/my-repo');
    });
  });
});
