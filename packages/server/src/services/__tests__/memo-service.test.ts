import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vol } from 'memfs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { MemoService } from '../memo-service.js';

const TEST_CONFIG_DIR = '/test/config';
const ORIGINAL_AGENT_CONSOLE_HOME = process.env.AGENT_CONSOLE_HOME;

describe('MemoService', () => {
  let service: MemoService;

  beforeEach(() => {
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    service = new MemoService();
  });

  afterEach(() => {
    cleanupMemfs();
    if (ORIGINAL_AGENT_CONSOLE_HOME === undefined) {
      delete process.env.AGENT_CONSOLE_HOME;
    } else {
      process.env.AGENT_CONSOLE_HOME = ORIGINAL_AGENT_CONSOLE_HOME;
    }
  });

  describe('writeMemo', () => {
    it('should create the memos directory and write the file', async () => {
      const filePath = await service.writeMemo('session-1', '# My Memo');

      expect(filePath).toBe(`${TEST_CONFIG_DIR}/_quick/memos/session-1.md`);
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/_quick/memos`)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('# My Memo');
    });

    it('should overwrite an existing memo', async () => {
      await service.writeMemo('session-1', 'first version');
      await service.writeMemo('session-1', 'second version');

      const content = vol.readFileSync(`${TEST_CONFIG_DIR}/_quick/memos/session-1.md`, 'utf-8');
      expect(content).toBe('second version');
    });

    it('should reject content exceeding 256KB', async () => {
      const oversized = 'x'.repeat(256 * 1024 + 1);
      await expect(service.writeMemo('session-1', oversized)).rejects.toThrow(
        /exceeds maximum size/,
      );
    });

    it('should handle multiple sessions independently', async () => {
      await service.writeMemo('session-a', 'memo A');
      await service.writeMemo('session-b', 'memo B');

      const contentA = vol.readFileSync(`${TEST_CONFIG_DIR}/_quick/memos/session-a.md`, 'utf-8');
      const contentB = vol.readFileSync(`${TEST_CONFIG_DIR}/_quick/memos/session-b.md`, 'utf-8');
      expect(contentA).toBe('memo A');
      expect(contentB).toBe('memo B');
    });
  });

  describe('readMemo', () => {
    it('should return content for an existing memo', async () => {
      await service.writeMemo('session-1', '# Hello');

      const content = await service.readMemo('session-1');
      expect(content).toBe('# Hello');
    });

    it('should return null when no memo exists', async () => {
      const content = await service.readMemo('nonexistent');
      expect(content).toBeNull();
    });
  });

  describe('deleteMemo', () => {
    it('should remove an existing memo file', async () => {
      await service.writeMemo('session-1', 'content');
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/_quick/memos/session-1.md`)).toBe(true);

      await service.deleteMemo('session-1');
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/_quick/memos/session-1.md`)).toBe(false);
    });

    it('should not throw when memo does not exist', async () => {
      // Ensure memos dir exists so rm doesn't fail on missing parent
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/memos`, { recursive: true });

      await expect(service.deleteMemo('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('repository-scoped paths', () => {
    it('should write memo to repository-scoped path when repositoryName is provided', async () => {
      const filePath = await service.writeMemo('session-1', '# Repo Memo', 'org/repo');

      expect(filePath).toBe(`${TEST_CONFIG_DIR}/repositories/org/repo/memos/session-1.md`);
      expect(vol.existsSync(filePath)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('# Repo Memo');
    });

    it('should read memo from repository-scoped path when repositoryName is provided', async () => {
      await service.writeMemo('session-1', '# Repo Memo', 'org/repo');

      const content = await service.readMemo('session-1', 'org/repo');
      expect(content).toBe('# Repo Memo');
    });

    it('should delete memo from repository-scoped path when repositoryName is provided', async () => {
      await service.writeMemo('session-1', 'content', 'org/repo');
      const filePath = `${TEST_CONFIG_DIR}/repositories/org/repo/memos/session-1.md`;
      expect(vol.existsSync(filePath)).toBe(true);

      await service.deleteMemo('session-1', 'org/repo');
      expect(vol.existsSync(filePath)).toBe(false);
    });

    it('should use _quick fallback when repositoryName is not provided', async () => {
      const filePath = await service.writeMemo('session-1', '# Quick Memo');

      expect(filePath).toBe(`${TEST_CONFIG_DIR}/_quick/memos/session-1.md`);
    });
  });

  describe('sessionId validation', () => {
    it('should reject sessionId with path traversal (..)', async () => {
      await expect(service.writeMemo('../etc/passwd', 'hack')).rejects.toThrow(/Invalid sessionId/);
      await expect(service.readMemo('../etc/passwd')).rejects.toThrow(/Invalid sessionId/);
      await expect(service.deleteMemo('../etc/passwd')).rejects.toThrow(/Invalid sessionId/);
    });

    it('should reject sessionId with slashes', async () => {
      await expect(service.writeMemo('foo/bar', 'hack')).rejects.toThrow(/Invalid sessionId/);
      await expect(service.readMemo('foo/bar')).rejects.toThrow(/Invalid sessionId/);
      await expect(service.deleteMemo('foo/bar')).rejects.toThrow(/Invalid sessionId/);
    });
  });
});
