import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { validateSessionPath } from '../path-validator.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

describe('path-validator', () => {
  // Test directories in memfs
  const testDir = '/test/validator';
  const safeSubDir = '/test/validator/safe';
  const homeDir = '/home/testuser';

  beforeEach(() => {
    setupMemfs({
      [`${safeSubDir}/.keep`]: '',
      [`${homeDir}/.keep`]: '',
      // Create /etc to test deny list (memfs allows this)
      '/etc/passwd': 'root:x:0:0:root:/root:/bin/bash',
      '/etc/ssh/config': '',
    });
  });

  afterEach(() => {
    cleanupMemfs();
  });

  describe('denied system directories', () => {
    it('should reject /etc', async () => {
      const result = await validateSessionPath('/etc');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /proc', async () => {
      const result = await validateSessionPath('/proc');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /sys', async () => {
      const result = await validateSessionPath('/sys');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /dev', async () => {
      const result = await validateSessionPath('/dev');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /boot', async () => {
      const result = await validateSessionPath('/boot');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /root', async () => {
      const result = await validateSessionPath('/root');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /bin', async () => {
      const result = await validateSessionPath('/bin');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /sbin', async () => {
      const result = await validateSessionPath('/sbin');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /System (macOS)', async () => {
      const result = await validateSessionPath('/System');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /private/etc (macOS)', async () => {
      const result = await validateSessionPath('/private/etc');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });
  });

  describe('subdirectory blocking', () => {
    it('should reject /etc/ssh (subdirectory of denied path)', async () => {
      const result = await validateSessionPath('/etc/ssh');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should reject /usr/bin/env (subdirectory of denied path)', async () => {
      const result = await validateSessionPath('/usr/bin/env');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });
  });

  describe('path traversal prevention', () => {
    it('should block path traversal to /etc', async () => {
      // Try to access /etc via path traversal
      const result = await validateSessionPath(`${testDir}/../../../../../../etc`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });

    it('should block path traversal to /etc', async () => {
      // /etc exists on both Linux and macOS
      const result = await validateSessionPath(`${testDir}/../../../../../../etc`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('restricted system directory');
    });
  });

  describe('symlink attack prevention', () => {
    it('should reject symlink pointing to /etc', async () => {
      // Create symlink in memfs
      const fs = await import('node:fs');
      const symlinkToEtc = `${testDir}/symlink-to-etc`;
      fs.symlinkSync('/etc', symlinkToEtc);

      const result = await validateSessionPath(symlinkToEtc);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('resolves to a restricted system directory');
    });
  });

  describe('allowed paths', () => {
    it('should allow valid directory', async () => {
      const result = await validateSessionPath(safeSubDir);
      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBeDefined();
      expect(result.resolvedPath).toContain('safe');
    });

    it('should allow home directory', async () => {
      const result = await validateSessionPath(homeDir);
      expect(result.valid).toBe(true);
    });

    it('should return resolved path for valid directory', async () => {
      const result = await validateSessionPath(testDir);
      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBeDefined();
    });
  });

  describe('non-existent paths', () => {
    it('should reject non-existent path', async () => {
      const result = await validateSessionPath('/nonexistent/path/that/does/not/exist');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('should reject non-existent subdirectory of valid path', async () => {
      const result = await validateSessionPath(`${testDir}/nonexistent-subdir`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  describe('edge cases', () => {
    it('should normalize paths with ./', async () => {
      const result = await validateSessionPath(`${safeSubDir}/./`);
      expect(result.valid).toBe(true);
    });

    it('should handle paths with trailing slashes', async () => {
      const result = await validateSessionPath(`${safeSubDir}/`);
      expect(result.valid).toBe(true);
    });

    it('should normalize parent directory references', async () => {
      // testDir/safe/../safe should resolve to testDir/safe
      const result = await validateSessionPath(`${safeSubDir}/../safe`);
      expect(result.valid).toBe(true);
    });
  });
});
