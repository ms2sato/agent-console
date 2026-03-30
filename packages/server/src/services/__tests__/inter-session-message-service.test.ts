import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vol } from 'memfs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import {
  InterSessionMessageService,
  validateId,
  MAX_MESSAGE_CONTENT_BYTES,
} from '../inter-session-message-service.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';

const TEST_CONFIG_DIR = '/test/config';
const quickResolver = new SessionDataPathResolver();
const repoResolver = new SessionDataPathResolver('org/repo');

describe('InterSessionMessageService', () => {
  let service: InterSessionMessageService;

  beforeEach(() => {
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    service = new InterSessionMessageService();
  });

  afterEach(() => {
    cleanupMemfs();
  });

  describe('sendMessage', () => {
    it('should create correct directory structure', async () => {
      await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content: 'hello',
        resolver: quickResolver,
      });

      const dirPath = `${TEST_CONFIG_DIR}/_quick/messages/session-target/worker-1`;
      const dirExists = vol.existsSync(dirPath);
      expect(dirExists).toBe(true);
    });

    it('should create file with correct name pattern: {timestamp}-{fromSessionId}-{randomHex}.json', async () => {
      const result = await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content: 'hello',
        resolver: quickResolver,
      });

      // messageId should match the pattern {timestamp}-{fromSessionId}-{randomHex}.json
      expect(result.messageId).toMatch(/^\d+-session-sender-[a-f0-9]{8}\.json$/);
    });

    it('should write correct file content', async () => {
      const content = JSON.stringify({ status: 'completed', summary: 'All done' });
      const result = await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content,
        resolver: quickResolver,
      });

      const fileContent = vol.readFileSync(result.path, 'utf-8');
      expect(fileContent).toBe(content);
    });

    it('should return messageId and absolute path', async () => {
      const result = await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content: 'test',
        resolver: quickResolver,
      });

      expect(result.messageId).toBeDefined();
      expect(result.path).toContain(TEST_CONFIG_DIR);
      expect(result.path).toContain('_quick/messages/session-target/worker-1');
      expect(result.path).toEndWith(result.messageId);
    });

    it('should not leave temp files after successful write', async () => {
      await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content: 'test',
        resolver: quickResolver,
      });

      const dirPath = `${TEST_CONFIG_DIR}/_quick/messages/session-target/worker-1`;
      const files = vol.readdirSync(dirPath) as string[];
      const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('should reject message content exceeding 64 KB', async () => {
      const oversizedContent = 'x'.repeat(MAX_MESSAGE_CONTENT_BYTES + 1);

      await expect(
        service.sendMessage({
          toSessionId: 'session-target',
          toWorkerId: 'worker-1',
          fromSessionId: 'session-sender',
          content: oversizedContent,
          resolver: quickResolver,
        }),
      ).rejects.toThrow('Message content too large');
    });

    it('should accept message content at exactly 64 KB', async () => {
      const exactContent = 'x'.repeat(MAX_MESSAGE_CONTENT_BYTES);

      const result = await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content: exactContent,
        resolver: quickResolver,
      });

      expect(result.messageId).toBeDefined();
      expect(vol.existsSync(result.path)).toBe(true);
    });

    it('should handle concurrent messages from different senders without collision', async () => {
      const [result1, result2] = await Promise.all([
        service.sendMessage({
          toSessionId: 'session-target',
          toWorkerId: 'worker-1',
          fromSessionId: 'sender-a',
          content: 'message from a',
          resolver: quickResolver,
        }),
        service.sendMessage({
          toSessionId: 'session-target',
          toWorkerId: 'worker-1',
          fromSessionId: 'sender-b',
          content: 'message from b',
          resolver: quickResolver,
        }),
      ]);

      // Both files should exist with different names
      expect(result1.messageId).not.toBe(result2.messageId);
      expect(vol.existsSync(result1.path)).toBe(true);
      expect(vol.existsSync(result2.path)).toBe(true);

      // Contents should be preserved
      expect(vol.readFileSync(result1.path, 'utf-8')).toBe('message from a');
      expect(vol.readFileSync(result2.path, 'utf-8')).toBe('message from b');
    });
  });

  describe('deleteSessionMessages', () => {
    it('should remove entire session directory recursively', async () => {
      // Create messages for two workers
      await service.sendMessage({
        toSessionId: 'session-1',
        toWorkerId: 'worker-1',
        fromSessionId: 'sender',
        content: 'msg1',
        resolver: quickResolver,
      });
      await service.sendMessage({
        toSessionId: 'session-1',
        toWorkerId: 'worker-2',
        fromSessionId: 'sender',
        content: 'msg2',
        resolver: quickResolver,
      });

      // Verify directory exists
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/_quick/messages/session-1`)).toBe(true);

      await service.deleteSessionMessages('session-1', quickResolver);

      expect(vol.existsSync(`${TEST_CONFIG_DIR}/_quick/messages/session-1`)).toBe(false);
    });

    it('should not throw when directory does not exist', async () => {
      // Should complete without error
      await expect(
        service.deleteSessionMessages('non-existent-session', quickResolver),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteWorkerMessages', () => {
    it('should remove only the specified worker directory', async () => {
      // Create messages for two different workers in the same session
      await service.sendMessage({
        toSessionId: 'session-1',
        toWorkerId: 'worker-1',
        fromSessionId: 'sender',
        content: 'keep this',
        resolver: quickResolver,
      });
      await service.sendMessage({
        toSessionId: 'session-1',
        toWorkerId: 'worker-2',
        fromSessionId: 'sender',
        content: 'delete this',
        resolver: quickResolver,
      });

      await service.deleteWorkerMessages('session-1', 'worker-2', quickResolver);

      // worker-1 messages should remain
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/_quick/messages/session-1/worker-1`)).toBe(true);
      // worker-2 messages should be gone
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/_quick/messages/session-1/worker-2`)).toBe(false);
    });

    it('should not throw when directory does not exist', async () => {
      await expect(
        service.deleteWorkerMessages('non-existent-session', 'non-existent-worker', quickResolver),
      ).resolves.toBeUndefined();
    });
  });

  describe('validateId', () => {
    it('should accept valid alphanumeric IDs', () => {
      expect(() => validateId('session-123', 'test')).not.toThrow();
      expect(() => validateId('abc_def', 'test')).not.toThrow();
      expect(() => validateId('a.b.c', 'test')).not.toThrow();
      expect(() => validateId('UUID-like-550e8400-e29b', 'test')).not.toThrow();
    });

    it('should reject path traversal attempts', () => {
      expect(() => validateId('../../../etc', 'test')).toThrow('Invalid test');
      expect(() => validateId('foo/bar', 'test')).toThrow('Invalid test');
      expect(() => validateId('foo\\bar', 'test')).toThrow('Invalid test');
    });

    it('should reject dots-only strings', () => {
      expect(() => validateId('.', 'test')).toThrow('Invalid test');
      expect(() => validateId('..', 'test')).toThrow('Invalid test');
      expect(() => validateId('...', 'test')).toThrow('Invalid test');
    });

    it('should reject empty strings', () => {
      expect(() => validateId('', 'test')).toThrow('Invalid test');
    });
  });

  describe('path traversal protection', () => {
    it('should reject sendMessage with traversal in fromSessionId', async () => {
      await expect(
        service.sendMessage({
          toSessionId: 'session-target',
          toWorkerId: 'worker-1',
          fromSessionId: '../../../etc',
          content: 'malicious',
          resolver: quickResolver,
        }),
      ).rejects.toThrow('Invalid fromSessionId');
    });

    it('should reject deleteSessionMessages with traversal in sessionId', async () => {
      await expect(
        service.deleteSessionMessages('../../../etc', quickResolver),
      ).rejects.toThrow('Invalid sessionId');
    });

    it('should reject deleteWorkerMessages with traversal in workerId', async () => {
      await expect(
        service.deleteWorkerMessages('valid-session', '../../../etc', quickResolver),
      ).rejects.toThrow('Invalid workerId');
    });
  });

  describe('repository-scoped paths', () => {
    it('should write to repository-scoped path when resolver has repositoryName', async () => {
      const result = await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content: 'hello',
        resolver: repoResolver,
      });

      expect(result.path).toContain(`${TEST_CONFIG_DIR}/repositories/org/repo/messages/session-target/worker-1`);
      expect(vol.existsSync(`${TEST_CONFIG_DIR}/repositories/org/repo/messages/session-target/worker-1`)).toBe(true);
    });

    it('should delete from repository-scoped path when resolver has repositoryName', async () => {
      await service.sendMessage({
        toSessionId: 'session-1',
        toWorkerId: 'worker-1',
        fromSessionId: 'sender',
        content: 'msg',
        resolver: repoResolver,
      });

      expect(vol.existsSync(`${TEST_CONFIG_DIR}/repositories/org/repo/messages/session-1`)).toBe(true);

      await service.deleteSessionMessages('session-1', repoResolver);

      expect(vol.existsSync(`${TEST_CONFIG_DIR}/repositories/org/repo/messages/session-1`)).toBe(false);
    });

    it('should write to _quick fallback path when resolver has no repositoryName', async () => {
      const result = await service.sendMessage({
        toSessionId: 'session-target',
        toWorkerId: 'worker-1',
        fromSessionId: 'session-sender',
        content: 'hello',
        resolver: quickResolver,
      });

      expect(result.path).toContain(`${TEST_CONFIG_DIR}/_quick/messages/session-target/worker-1`);
    });
  });

  describe('message ID uniqueness', () => {
    it('should produce unique files when same sender sends two messages rapidly', async () => {
      const [result1, result2] = await Promise.all([
        service.sendMessage({
          toSessionId: 'session-target',
          toWorkerId: 'worker-1',
          fromSessionId: 'same-sender',
          content: 'message 1',
          resolver: quickResolver,
        }),
        service.sendMessage({
          toSessionId: 'session-target',
          toWorkerId: 'worker-1',
          fromSessionId: 'same-sender',
          content: 'message 2',
          resolver: quickResolver,
        }),
      ]);

      // Both files should have unique messageIds
      expect(result1.messageId).not.toBe(result2.messageId);

      // Both files should exist
      expect(vol.existsSync(result1.path)).toBe(true);
      expect(vol.existsSync(result2.path)).toBe(true);

      // Contents should be preserved correctly
      expect(vol.readFileSync(result1.path, 'utf-8')).toBe('message 1');
      expect(vol.readFileSync(result2.path, 'utf-8')).toBe('message 2');
    });
  });
});
