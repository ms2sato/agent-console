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

      expect(filePath).toBe(`${TEST_CONFIG_DIR}/memos/session-1.md`);
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/memos`)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('# My Memo');
    });

    it('should overwrite an existing memo', async () => {
      await service.writeMemo('session-1', 'first version');
      await service.writeMemo('session-1', 'second version');

      const content = vol.readFileSync(`${TEST_CONFIG_DIR}/memos/session-1.md`, 'utf-8');
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

      const contentA = vol.readFileSync(`${TEST_CONFIG_DIR}/memos/session-a.md`, 'utf-8');
      const contentB = vol.readFileSync(`${TEST_CONFIG_DIR}/memos/session-b.md`, 'utf-8');
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
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/memos/session-1.md`)).toBe(true);

      await service.deleteMemo('session-1');
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/memos/session-1.md`)).toBe(false);
    });

    it('should not throw when memo does not exist', async () => {
      // Ensure memos dir exists so rm doesn't fail on missing parent
      vol.mkdirSync(`${TEST_CONFIG_DIR}/memos`, { recursive: true });

      await expect(service.deleteMemo('nonexistent')).resolves.toBeUndefined();
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
