import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getConfigDir', () => {
    it('should return default path when AGENT_CONSOLE_HOME is not set', async () => {
      delete process.env.AGENT_CONSOLE_HOME;
      const { getConfigDir } = await import('../config.js');

      const expected = path.join(os.homedir(), '.agent-console');
      expect(getConfigDir()).toBe(expected);
    });

    it('should return AGENT_CONSOLE_HOME when set', async () => {
      process.env.AGENT_CONSOLE_HOME = '/custom/config/path';
      const { getConfigDir } = await import('../config.js');

      expect(getConfigDir()).toBe('/custom/config/path');
    });

    it('should return different paths for different AGENT_CONSOLE_HOME values', async () => {
      process.env.AGENT_CONSOLE_HOME = '/path/one';
      const { getConfigDir: getConfigDir1 } = await import('../config.js');
      expect(getConfigDir1()).toBe('/path/one');

      vi.resetModules();
      process.env.AGENT_CONSOLE_HOME = '/path/two';
      const { getConfigDir: getConfigDir2 } = await import('../config.js');
      expect(getConfigDir2()).toBe('/path/two');
    });
  });

  describe('getServerPid', () => {
    it('should return current process PID', async () => {
      const { getServerPid } = await import('../config.js');

      expect(getServerPid()).toBe(process.pid);
      expect(typeof getServerPid()).toBe('number');
    });
  });
});
