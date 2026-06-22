import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import { getConfigDir, getRepositoriesDir, getRepositoryDir, getServerPid } from '../config.js';

describe('config', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  const originalAuthMode = process.env.AUTH_MODE;

  beforeEach(() => {
    // Clear both env vars to test default behavior in each test.
    delete process.env.AGENT_CONSOLE_HOME;
    delete process.env.AUTH_MODE;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
    if (originalAuthMode !== undefined) {
      process.env.AUTH_MODE = originalAuthMode;
    } else {
      delete process.env.AUTH_MODE;
    }
  });

  describe('getConfigDir', () => {
    it('should return default path under HOME when neither env var is set', () => {
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

    // Issue #830: AUTH_MODE=multi-user relocates the default data root to a
    // system-wide path so that the per-user PTY (running as the logged-in
    // user, not the service user) can traverse into it.
    it('should return /var/lib/agent-console under AUTH_MODE=multi-user when AGENT_CONSOLE_HOME is unset (#830)', () => {
      process.env.AUTH_MODE = 'multi-user';

      expect(getConfigDir()).toBe('/var/lib/agent-console');
    });

    it('should honour AGENT_CONSOLE_HOME precedence over the multi-user default (#830)', () => {
      process.env.AUTH_MODE = 'multi-user';
      process.env.AGENT_CONSOLE_HOME = '/srv/agent-console-data';

      expect(getConfigDir()).toBe('/srv/agent-console-data');
    });

    it('should not apply the multi-user default for any other AUTH_MODE value (#830)', () => {
      process.env.AUTH_MODE = 'none';

      const expected = path.join(os.homedir(), '.agent-console');
      expect(getConfigDir()).toBe(expected);
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
      const expected = path.join(os.homedir(), '.agent-console', 'repositories');
      expect(getRepositoriesDir()).toBe(expected);
    });

    it('should respect AGENT_CONSOLE_HOME', () => {
      process.env.AGENT_CONSOLE_HOME = '/custom/path';

      expect(getRepositoriesDir()).toBe('/custom/path/repositories');
    });

    it('should follow the multi-user data root under AUTH_MODE=multi-user (#830)', () => {
      process.env.AUTH_MODE = 'multi-user';

      expect(getRepositoriesDir()).toBe('/var/lib/agent-console/repositories');
    });
  });

  describe('getRepositoryDir', () => {
    it('should return repository-specific directory', () => {
      const expected = path.join(os.homedir(), '.agent-console', 'repositories', 'owner/repo');
      expect(getRepositoryDir('owner/repo')).toBe(expected);
    });

    it('should handle simple repo names', () => {
      process.env.AGENT_CONSOLE_HOME = '/config';

      expect(getRepositoryDir('my-repo')).toBe('/config/repositories/my-repo');
    });
  });
});
