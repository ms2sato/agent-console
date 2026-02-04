import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { vol } from 'memfs';
import { SdkMessageFileManager } from '../sdk-message-file-manager.js';
import type { SDKMessage } from '@agent-console/shared';

describe('SdkMessageFileManager', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let manager: SdkMessageFileManager;

  beforeEach(() => {
    setupMemfs({});
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    manager = new SdkMessageFileManager();
  });

  afterEach(() => {
    cleanupMemfs();
  });

  describe('getMessagesFilePath', () => {
    it('should return correct path structure', () => {
      const path = manager.getMessagesFilePath('session-1', 'worker-1');
      expect(path).toBe(`${TEST_CONFIG_DIR}/sessions/session-1/workers/worker-1/sdk-messages.jsonl`);
    });

    it('should handle special characters in IDs', () => {
      const path = manager.getMessagesFilePath('session_123', 'worker-abc');
      expect(path).toBe(`${TEST_CONFIG_DIR}/sessions/session_123/workers/worker-abc/sdk-messages.jsonl`);
    });
  });

  describe('initializeWorkerFile', () => {
    it('should create empty file and directory structure', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');

      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      expect(vol.existsSync(filePath)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('');
    });

    it('should truncate existing file', async () => {
      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      vol.mkdirSync(`${TEST_CONFIG_DIR}/sessions/session-1/workers/worker-1`, { recursive: true });
      vol.writeFileSync(filePath, 'existing content');

      await manager.initializeWorkerFile('session-1', 'worker-1');

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('');
    });

    it('should handle multiple workers independently', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');
      await manager.initializeWorkerFile('session-1', 'worker-2');

      const path1 = manager.getMessagesFilePath('session-1', 'worker-1');
      const path2 = manager.getMessagesFilePath('session-1', 'worker-2');

      expect(vol.existsSync(path1)).toBe(true);
      expect(vol.existsSync(path2)).toBe(true);
    });
  });

  describe('appendMessage', () => {
    const testMessage: SDKMessage = {
      type: 'system',
      uuid: 'test-uuid-1',
      session_id: 'sdk-session-123',
    };

    it('should append message as JSONL', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');
      await manager.appendMessage('session-1', 'worker-1', testMessage);

      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      const content = vol.readFileSync(filePath, 'utf-8');

      expect(content).toBe(JSON.stringify(testMessage) + '\n');
    });

    it('should append multiple messages sequentially', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');

      const message1: SDKMessage = { type: 'system', uuid: 'uuid-1' };
      const message2: SDKMessage = { type: 'assistant', uuid: 'uuid-2' };
      const message3: SDKMessage = { type: 'result', uuid: 'uuid-3' };

      await manager.appendMessage('session-1', 'worker-1', message1);
      await manager.appendMessage('session-1', 'worker-1', message2);
      await manager.appendMessage('session-1', 'worker-1', message3);

      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      const content = vol.readFileSync(filePath, 'utf-8') as string;

      const lines = content.split('\n').filter((l) => l.trim() !== '');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toEqual(message1);
      expect(JSON.parse(lines[1])).toEqual(message2);
      expect(JSON.parse(lines[2])).toEqual(message3);
    });

    it('should create directory if it does not exist', async () => {
      // Don't initialize, just append directly
      await manager.appendMessage('session-1', 'worker-1', testMessage);

      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      expect(vol.existsSync(filePath)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe(JSON.stringify(testMessage) + '\n');
    });

    it('should handle messages with complex nested data', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');

      const complexMessage: SDKMessage = {
        type: 'assistant',
        uuid: 'complex-uuid',
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/test' } },
          ],
        },
      };

      await manager.appendMessage('session-1', 'worker-1', complexMessage);

      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      const content = vol.readFileSync(filePath, 'utf-8') as string;
      const parsed = JSON.parse(content.trim());

      expect(parsed).toEqual(complexMessage);
    });
  });

  describe('readMessages', () => {
    it('should read all messages from file', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');

      const message1: SDKMessage = { type: 'system', uuid: 'uuid-1' };
      const message2: SDKMessage = { type: 'assistant', uuid: 'uuid-2' };
      const message3: SDKMessage = { type: 'result', uuid: 'uuid-3' };

      await manager.appendMessage('session-1', 'worker-1', message1);
      await manager.appendMessage('session-1', 'worker-1', message2);
      await manager.appendMessage('session-1', 'worker-1', message3);

      const messages = await manager.readMessages('session-1', 'worker-1');

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual(message1);
      expect(messages[1]).toEqual(message2);
      expect(messages[2]).toEqual(message3);
    });

    it('should return empty array for non-existent file', async () => {
      const messages = await manager.readMessages('nonexistent', 'worker-1');
      expect(messages).toEqual([]);
    });

    it('should return empty array for empty file', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');

      const messages = await manager.readMessages('session-1', 'worker-1');
      expect(messages).toEqual([]);
    });

    it('should skip invalid JSON lines and continue', async () => {
      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      vol.mkdirSync(`${TEST_CONFIG_DIR}/sessions/session-1/workers/worker-1`, { recursive: true });

      const validMessage: SDKMessage = { type: 'system', uuid: 'valid' };
      const content = [
        JSON.stringify(validMessage),
        'not valid json',
        JSON.stringify({ type: 'result', uuid: 'also-valid' }),
      ].join('\n');
      vol.writeFileSync(filePath, content);

      const messages = await manager.readMessages('session-1', 'worker-1');

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(validMessage);
      expect(messages[1]).toEqual({ type: 'result', uuid: 'also-valid' });
    });

    it('should handle empty lines in the file', async () => {
      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      vol.mkdirSync(`${TEST_CONFIG_DIR}/sessions/session-1/workers/worker-1`, { recursive: true });

      const message: SDKMessage = { type: 'system', uuid: 'test' };
      const content = '\n' + JSON.stringify(message) + '\n\n\n';
      vol.writeFileSync(filePath, content);

      const messages = await manager.readMessages('session-1', 'worker-1');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(message);
    });
  });

  describe('clearWorkerFile', () => {
    it('should delete the messages file', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');
      await manager.appendMessage('session-1', 'worker-1', { type: 'system', uuid: 'test' });

      const filePath = manager.getMessagesFilePath('session-1', 'worker-1');
      expect(vol.existsSync(filePath)).toBe(true);

      await manager.clearWorkerFile('session-1', 'worker-1');

      expect(vol.existsSync(filePath)).toBe(false);
    });

    it('should not throw for non-existent file', async () => {
      await expect(
        manager.clearWorkerFile('nonexistent', 'worker-1')
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteSessionFiles', () => {
    it('should delete entire session directory', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');
      await manager.initializeWorkerFile('session-1', 'worker-2');
      await manager.appendMessage('session-1', 'worker-1', { type: 'system', uuid: 'test' });

      const sessionDir = `${TEST_CONFIG_DIR}/sessions/session-1`;
      expect(vol.existsSync(sessionDir)).toBe(true);

      await manager.deleteSessionFiles('session-1');

      expect(vol.existsSync(sessionDir)).toBe(false);
    });

    it('should not affect other sessions', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');
      await manager.initializeWorkerFile('session-2', 'worker-1');

      await manager.deleteSessionFiles('session-1');

      const session1Dir = `${TEST_CONFIG_DIR}/sessions/session-1`;
      const session2Dir = `${TEST_CONFIG_DIR}/sessions/session-2`;

      expect(vol.existsSync(session1Dir)).toBe(false);
      expect(vol.existsSync(session2Dir)).toBe(true);
    });

    it('should not throw for non-existent session', async () => {
      await expect(
        manager.deleteSessionFiles('nonexistent')
      ).resolves.toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    it('should support worker restart with message recovery', async () => {
      // Simulate initial worker run
      await manager.initializeWorkerFile('session-1', 'worker-1');
      const messages: SDKMessage[] = [
        { type: 'system', uuid: 'uuid-1', session_id: 'sdk-123' },
        { type: 'assistant', uuid: 'uuid-2', message: { content: 'Hello' } },
        { type: 'result', uuid: 'uuid-3', result: 'done' },
      ];
      for (const msg of messages) {
        await manager.appendMessage('session-1', 'worker-1', msg);
      }

      // Simulate server restart - create new manager instance
      const newManager = new SdkMessageFileManager();

      // Recover messages
      const recovered = await newManager.readMessages('session-1', 'worker-1');

      expect(recovered).toHaveLength(3);
      expect(recovered).toEqual(messages);
    });

    it('should handle concurrent writes to different workers', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');
      await manager.initializeWorkerFile('session-1', 'worker-2');

      // Write concurrently
      await Promise.all([
        manager.appendMessage('session-1', 'worker-1', { type: 'system', uuid: 'w1-1' }),
        manager.appendMessage('session-1', 'worker-2', { type: 'system', uuid: 'w2-1' }),
        manager.appendMessage('session-1', 'worker-1', { type: 'assistant', uuid: 'w1-2' }),
        manager.appendMessage('session-1', 'worker-2', { type: 'assistant', uuid: 'w2-2' }),
      ]);

      const worker1Messages = await manager.readMessages('session-1', 'worker-1');
      const worker2Messages = await manager.readMessages('session-1', 'worker-2');

      expect(worker1Messages).toHaveLength(2);
      expect(worker2Messages).toHaveLength(2);

      // Verify messages are in correct files
      expect(worker1Messages.some(m => m.uuid === 'w1-1')).toBe(true);
      expect(worker1Messages.some(m => m.uuid === 'w1-2')).toBe(true);
      expect(worker2Messages.some(m => m.uuid === 'w2-1')).toBe(true);
      expect(worker2Messages.some(m => m.uuid === 'w2-2')).toBe(true);
    });

    it('should handle unicode content in messages', async () => {
      await manager.initializeWorkerFile('session-1', 'worker-1');

      const unicodeMessage: SDKMessage = {
        type: 'assistant',
        uuid: 'unicode',
        message: {
          content: [
            { type: 'text', text: 'Hello \u4e16\u754c \ud83c\udf0d \ud83d\ude00' },
          ],
        },
      };

      await manager.appendMessage('session-1', 'worker-1', unicodeMessage);

      const messages = await manager.readMessages('session-1', 'worker-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(unicodeMessage);
    });
  });
});
