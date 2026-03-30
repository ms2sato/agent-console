import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { vol } from 'memfs';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';

// Test-specific config values for worker output file tests
// Note: These are used directly in the tests that need smaller values
const TEST_WORKER_OUTPUT_FILE_MAX_SIZE = 1024; // 1KB for easier testing
const TEST_WORKER_OUTPUT_FLUSH_INTERVAL = 100; // 100ms (same as default)
const TEST_WORKER_OUTPUT_FLUSH_THRESHOLD = 256; // 256 bytes for easier testing

const quickResolver = new SessionDataPathResolver();
const repoResolver = new SessionDataPathResolver('org/repo');

describe('WorkerOutputFileManager', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let manager: WorkerOutputFileManager;

  beforeEach(() => {
    setupMemfs({});
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    manager = new WorkerOutputFileManager({
      flushThreshold: TEST_WORKER_OUTPUT_FLUSH_THRESHOLD,
      flushInterval: TEST_WORKER_OUTPUT_FLUSH_INTERVAL,
      fileMaxSize: TEST_WORKER_OUTPUT_FILE_MAX_SIZE,
    });
  });

  afterEach(() => {
    cleanupMemfs();
  });

  describe('getOutputFilePath', () => {
    it('should return correct path structure', () => {
      const path = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      expect(path).toBe(`${TEST_CONFIG_DIR}/_quick/outputs/session-1/worker-1.log`);
    });

    it('should handle special characters in IDs', () => {
      const path = manager.getOutputFilePath('session_123', 'worker-abc', quickResolver);
      expect(path).toBe(`${TEST_CONFIG_DIR}/_quick/outputs/session_123/worker-abc.log`);
    });
  });

  describe('bufferOutput and flush', () => {
    it('should buffer output data', () => {
      // Use unique IDs to avoid interference with other tests
      manager.bufferOutput('session-buffer', 'worker-buffer', 'test data', quickResolver);

      // Data is buffered, not yet written to file
      const filePath = manager.getOutputFilePath('session-buffer', 'worker-buffer', quickResolver);
      expect(vol.existsSync(filePath)).toBe(false);
    });

    it('should flush buffer after interval', async () => {
      manager.bufferOutput('session-flush', 'worker-flush', 'test data', quickResolver);

      // Wait for flush interval to trigger
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-flush', 'worker-flush', quickResolver);
      expect(vol.existsSync(filePath)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('test data');
    });

    it('should accumulate multiple buffers before flush', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'part1', quickResolver);
      manager.bufferOutput('session-1', 'worker-1', 'part2', quickResolver);
      manager.bufferOutput('session-1', 'worker-1', 'part3', quickResolver);

      // Wait for flush
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('part1part2part3');
    });

    it('should flush immediately when buffer exceeds threshold', async () => {
      // Create data larger than threshold (256 bytes)
      const largeData = 'x'.repeat(300);
      manager.bufferOutput('session-1', 'worker-1', largeData, quickResolver);

      // Small delay to allow async flush to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      expect(vol.existsSync(filePath)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe(largeData);
    });

    it('should append to existing file', async () => {
      // First flush
      manager.bufferOutput('session-1', 'worker-1', 'first', quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Second flush
      manager.bufferOutput('session-1', 'worker-1', 'second', quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('firstsecond');
    });

    it('should handle multiple workers independently', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'worker1-data', quickResolver);
      manager.bufferOutput('session-1', 'worker-2', 'worker2-data', quickResolver);

      await new Promise(resolve => setTimeout(resolve, 150));

      const path1 = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const path2 = manager.getOutputFilePath('session-1', 'worker-2', quickResolver);

      expect(vol.readFileSync(path1, 'utf-8')).toBe('worker1-data');
      expect(vol.readFileSync(path2, 'utf-8')).toBe('worker2-data');
    });

    it('should handle multiple sessions independently', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'session1-data', quickResolver);
      manager.bufferOutput('session-2', 'worker-1', 'session2-data', quickResolver);

      await new Promise(resolve => setTimeout(resolve, 150));

      const path1 = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const path2 = manager.getOutputFilePath('session-2', 'worker-1', quickResolver);

      expect(vol.readFileSync(path1, 'utf-8')).toBe('session1-data');
      expect(vol.readFileSync(path2, 'utf-8')).toBe('session2-data');
    });
  });

  describe('readHistoryWithOffset', () => {
    it('should read full history when no offset specified', async () => {
      // Create file with content
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'hello world');

      const result = await manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('hello world');
      expect(result!.offset).toBe(11); // length of 'hello world'
    });

    it('should read history from specific offset', async () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'hello world');

      // Read from offset 6 (skip 'hello ')
      const result = await manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver, 6);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('world');
      expect(result!.offset).toBe(11);
    });

    it('should return empty data when offset equals file size', async () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'hello world');

      const result = await manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver, 11);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('');
      expect(result!.offset).toBe(11);
    });

    it('should return full history when offset exceeds file size (truncation resync)', async () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'hello world');

      // Client has offset 100 but file is only 11 bytes — file was truncated
      const result = await manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver, 100);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('hello world');
      expect(result!.offset).toBe(11);
    });

    it('should return empty history for non-existent file', async () => {
      const result = await manager.readHistoryWithOffset('nonexistent', 'worker-1', quickResolver);
      // Returns empty history instead of null to support newly created workers
      expect(result).not.toBeNull();
      expect(result!.data).toBe('');
      expect(result!.offset).toBe(0);
    });

    it('should return pending buffer when file does not exist', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'pending data', quickResolver);

      // File doesn't exist yet, but buffer has data
      const result = await manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('pending data');
      expect(result!.offset).toBe(12); // length of 'pending data'
    });

    it('should return byte length offset for multi-byte UTF-8 pending buffer', async () => {
      // Japanese characters: 3 bytes each in UTF-8
      // 'テスト' = 3 characters, but 9 bytes in UTF-8
      const multiByteData = 'テスト';
      manager.bufferOutput('session-1', 'worker-1', multiByteData, quickResolver);

      const result = await manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('テスト');
      // Offset must be in bytes (9), not characters (3)
      expect(result!.offset).toBe(9);
      expect(result!.offset).toBe(Buffer.byteLength(multiByteData, 'utf-8'));
    });
  });

  describe('getCurrentOffset', () => {
    it('should return file size when file exists', async () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'hello world');

      const offset = await manager.getCurrentOffset('session-1', 'worker-1', quickResolver);
      expect(offset).toBe(11);
    });

    it('should return 0 for non-existent file', async () => {
      const offset = await manager.getCurrentOffset('nonexistent', 'worker-1', quickResolver);
      expect(offset).toBe(0);
    });

    it('should flush pending buffer before returning offset', async () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'hello'); // 5 bytes

      manager.bufferOutput('session-1', 'worker-1', ' world', quickResolver); // 6 bytes pending

      // getCurrentOffset flushes buffer first, so we get total file size
      const offset = await manager.getCurrentOffset('session-1', 'worker-1', quickResolver);
      expect(offset).toBe(11); // 5 + 6
    });

    it('should return pending buffer size when only buffer exists', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'pending', quickResolver);

      const offset = await manager.getCurrentOffset('session-1', 'worker-1', quickResolver);
      expect(offset).toBe(7);
    });
  });

  describe('file size limit and truncation', () => {
    it('should truncate file when exceeding max size', async () => {
      // Max size is 1024 bytes, flush threshold is 256 bytes
      // We need to write more than 1024 bytes total to trigger truncation

      // Write 500 bytes first
      const chunk1 = 'A'.repeat(500);
      manager.bufferOutput('session-1', 'worker-1', chunk1, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Write another 600 bytes (total: 1100 bytes, exceeds 1024 limit)
      const chunk2 = 'B'.repeat(600);
      manager.bufferOutput('session-1', 'worker-1', chunk2, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8') as string;

      // File should be truncated to ~80% of max size (819 bytes)
      // It should contain the most recent data (end of content)
      expect(content.length).toBeLessThanOrEqual(TEST_WORKER_OUTPUT_FILE_MAX_SIZE);
      expect(content.endsWith('B'.repeat(Math.min(600, content.length)))).toBe(true);
    });

    it('should keep most recent data after truncation', async () => {
      // Write enough data to trigger truncation
      const oldData = 'OLD_'.repeat(300); // 1200 bytes
      manager.bufferOutput('session-1', 'worker-1', oldData, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      const newData = 'NEW_'.repeat(50); // 200 bytes
      manager.bufferOutput('session-1', 'worker-1', newData, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8') as string;

      // New data should be preserved
      expect(content).toContain('NEW_');
    });
  });

  describe('deleteWorkerOutput', () => {
    it('should delete worker output file', async () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'content');

      await manager.deleteWorkerOutput('session-1', 'worker-1', quickResolver);

      expect(vol.existsSync(filePath)).toBe(false);
    });

    it('should clear pending buffer when deleting', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'pending', quickResolver);

      await manager.deleteWorkerOutput('session-1', 'worker-1', quickResolver);

      // After deletion, offset should be 0
      const offset = await manager.getCurrentOffset('session-1', 'worker-1', quickResolver);
      expect(offset).toBe(0);
    });

    it('should not throw for non-existent file', async () => {
      await expect(
        manager.deleteWorkerOutput('nonexistent', 'worker-1', quickResolver)
      ).resolves.toBeUndefined();
    });

    it('should cancel pending flush timer when deleting', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'pending', quickResolver);

      // Delete before flush timer fires
      await manager.deleteWorkerOutput('session-1', 'worker-1', quickResolver);

      // Wait for what would be the flush interval
      await new Promise(resolve => setTimeout(resolve, 150));

      // File should not exist since we deleted before flush
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      expect(vol.existsSync(filePath)).toBe(false);
    });
  });

  describe('deleteSessionOutputs', () => {
    it('should delete all output files for a session', async () => {
      const sessionDir = `${TEST_CONFIG_DIR}/_quick/outputs/session-1`;
      vol.mkdirSync(sessionDir, { recursive: true });
      vol.writeFileSync(`${sessionDir}/worker-1.log`, 'content1');
      vol.writeFileSync(`${sessionDir}/worker-2.log`, 'content2');
      vol.writeFileSync(`${sessionDir}/worker-3.log`, 'content3');

      await manager.deleteSessionOutputs('session-1', quickResolver);

      expect(vol.existsSync(sessionDir)).toBe(false);
    });

    it('should not affect other sessions', async () => {
      const session1Dir = `${TEST_CONFIG_DIR}/_quick/outputs/session-1`;
      const session2Dir = `${TEST_CONFIG_DIR}/_quick/outputs/session-2`;
      vol.mkdirSync(session1Dir, { recursive: true });
      vol.mkdirSync(session2Dir, { recursive: true });
      vol.writeFileSync(`${session1Dir}/worker-1.log`, 'content1');
      vol.writeFileSync(`${session2Dir}/worker-1.log`, 'content2');

      await manager.deleteSessionOutputs('session-1', quickResolver);

      expect(vol.existsSync(session1Dir)).toBe(false);
      expect(vol.existsSync(session2Dir)).toBe(true);
      expect(vol.existsSync(`${session2Dir}/worker-1.log`)).toBe(true);
    });

    it('should clear all pending buffers for the session', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'pending1', quickResolver);
      manager.bufferOutput('session-1', 'worker-2', 'pending2', quickResolver);
      manager.bufferOutput('session-2', 'worker-1', 'pending3', quickResolver);

      await manager.deleteSessionOutputs('session-1', quickResolver);

      // Session-1 workers should have 0 offset
      expect(await manager.getCurrentOffset('session-1', 'worker-1', quickResolver)).toBe(0);
      expect(await manager.getCurrentOffset('session-1', 'worker-2', quickResolver)).toBe(0);

      // Session-2 should still have pending data
      expect(await manager.getCurrentOffset('session-2', 'worker-1', quickResolver)).toBe(8);
    });

    it('should not throw for non-existent session', async () => {
      await expect(
        manager.deleteSessionOutputs('nonexistent', quickResolver)
      ).resolves.toBeUndefined();
    });
  });

  describe('flushAll', () => {
    it('should flush all pending buffers', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'data1', quickResolver);
      manager.bufferOutput('session-2', 'worker-1', 'data2', quickResolver);

      // Flush all without waiting for timers
      await manager.flushAll();

      const path1 = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const path2 = manager.getOutputFilePath('session-2', 'worker-1', quickResolver);

      expect(vol.readFileSync(path1, 'utf-8')).toBe('data1');
      expect(vol.readFileSync(path2, 'utf-8')).toBe('data2');
    });

    it('should complete successfully with no pending buffers', async () => {
      await expect(manager.flushAll()).resolves.toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty data buffer', async () => {
      manager.bufferOutput('session-1', 'worker-1', '', quickResolver);

      await new Promise(resolve => setTimeout(resolve, 150));

      // Empty buffer should not create file
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      expect(vol.existsSync(filePath)).toBe(false);
    });

    it('should handle unicode characters', async () => {
      const unicodeData = 'Hello \u4e16\u754c \ud83c\udf0d'; // Hello World in Chinese + globe emoji
      manager.bufferOutput('session-1', 'worker-1', unicodeData, quickResolver);

      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe(unicodeData);
    });

    it('should handle ANSI escape sequences', async () => {
      const ansiData = '\x1b[31mRed text\x1b[0m and \x1b[32mgreen\x1b[0m';
      manager.bufferOutput('session-1', 'worker-1', ansiData, quickResolver);

      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe(ansiData);
    });

    it('should handle newlines and carriage returns', async () => {
      const textWithNewlines = 'line1\nline2\r\nline3\rline4';
      manager.bufferOutput('session-1', 'worker-1', textWithNewlines, quickResolver);

      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe(textWithNewlines);
    });

    it('should handle rapid sequential writes', async () => {
      // Simulate rapid terminal output
      for (let i = 0; i < 100; i++) {
        manager.bufferOutput('session-1', 'worker-1', `line${i}\n`, quickResolver);
      }

      await new Promise(resolve => setTimeout(resolve, 200));

      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8') as string;

      // Should contain all lines (or be truncated but consistent)
      const lines = content.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
    });

    it('should include pending buffer when reading with file existing', async () => {
      // Write some data to file first
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'existing');

      // Buffer more data (not flushed yet)
      manager.bufferOutput('session-1', 'worker-1', ' new', quickResolver);

      // Read should return file content + pending buffer
      const result = await manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver);

      expect(result).not.toBeNull();
      // Both file content and pending buffer should be included
      expect(result!.data).toBe('existing new');
      // Offset should be file size (8) + pending buffer byte length (4)
      expect(result!.offset).toBe(12);
    });

    it('should return only pending buffer when offset equals file size', async () => {
      const filePath = manager.getOutputFilePath('session-offset-eq', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-offset-eq`, { recursive: true });
      vol.writeFileSync(filePath, 'existing'); // 8 bytes

      // Buffer more data (not flushed yet)
      manager.bufferOutput('session-offset-eq', 'worker-1', ' new', quickResolver); // 4 bytes

      // Read from offset 8 (file size) should return only pending buffer
      const result = await manager.readHistoryWithOffset('session-offset-eq', 'worker-1', quickResolver, 8);

      expect(result).not.toBeNull();
      expect(result!.data).toBe(' new');
      expect(result!.offset).toBe(12); // 8 + 4
    });

    it('should return partial pending buffer when offset is within pending buffer range', async () => {
      const filePath = manager.getOutputFilePath('session-partial', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-partial`, { recursive: true });
      vol.writeFileSync(filePath, 'file'); // 4 bytes

      // Buffer more data (not flushed yet)
      manager.bufferOutput('session-partial', 'worker-1', 'buffer', quickResolver); // 6 bytes

      // Read from offset 6 (2 bytes into pending buffer) should return partial pending buffer
      const result = await manager.readHistoryWithOffset('session-partial', 'worker-1', quickResolver, 6);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('ffer'); // skipped 'bu' (2 bytes)
      expect(result!.offset).toBe(10); // 4 + 6
    });

    it('should return empty when offset equals total size (file + pending)', async () => {
      const filePath = manager.getOutputFilePath('session-total', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-total`, { recursive: true });
      vol.writeFileSync(filePath, 'file'); // 4 bytes

      // Buffer more data (not flushed yet)
      manager.bufferOutput('session-total', 'worker-1', 'buffer', quickResolver); // 6 bytes

      // Read from offset 10 (total size) should return empty
      const result = await manager.readHistoryWithOffset('session-total', 'worker-1', quickResolver, 10);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('');
      expect(result!.offset).toBe(10);
    });

    it('should return full history when offset exceeds total size (file + pending) after truncation', async () => {
      const filePath = manager.getOutputFilePath('session-total-exceed', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-total-exceed`, { recursive: true });
      vol.writeFileSync(filePath, 'file'); // 4 bytes

      manager.bufferOutput('session-total-exceed', 'worker-1', 'buffer', quickResolver); // 6 bytes

      // Client has offset 50 but total is only 10 bytes — file was truncated
      const result = await manager.readHistoryWithOffset('session-total-exceed', 'worker-1', quickResolver, 50);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('filebuffer');
      expect(result!.offset).toBe(10);
    });

    it('should return file data from offset + full pending buffer', async () => {
      const filePath = manager.getOutputFilePath('session-mid', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-mid`, { recursive: true });
      vol.writeFileSync(filePath, 'hello world'); // 11 bytes

      // Buffer more data (not flushed yet)
      manager.bufferOutput('session-mid', 'worker-1', '!!!', quickResolver); // 3 bytes

      // Read from offset 6 should return 'world' + '!!!'
      const result = await manager.readHistoryWithOffset('session-mid', 'worker-1', quickResolver, 6);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('world!!!');
      expect(result!.offset).toBe(14); // 11 + 3
    });

    it('should handle multi-byte UTF-8 in pending buffer with offset', async () => {
      const filePath = manager.getOutputFilePath('session-utf8-pending', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-utf8-pending`, { recursive: true });
      vol.writeFileSync(filePath, 'ABC'); // 3 bytes

      // Buffer Japanese characters (3 bytes each)
      manager.bufferOutput('session-utf8-pending', 'worker-1', '日本語', quickResolver); // 9 bytes

      // Read from offset 3 (file size) should return full pending buffer
      const result = await manager.readHistoryWithOffset('session-utf8-pending', 'worker-1', quickResolver, 3);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('日本語');
      expect(result!.offset).toBe(12); // 3 + 9

      // Read from offset 6 (3 bytes into pending buffer) should return '本語'
      const result2 = await manager.readHistoryWithOffset('session-utf8-pending', 'worker-1', quickResolver, 6);

      expect(result2).not.toBeNull();
      expect(result2!.data).toBe('本語');
      expect(result2!.offset).toBe(12);
    });
  });

  describe('concurrent operations', () => {
    it('should handle concurrent reads and writes', async () => {
      // Write initial data
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-1`, { recursive: true });
      vol.writeFileSync(filePath, 'initial');

      // Perform concurrent operations
      const promises = [
        manager.readHistoryWithOffset('session-1', 'worker-1', quickResolver),
        manager.getCurrentOffset('session-1', 'worker-1', quickResolver),
        (async () => {
          manager.bufferOutput('session-1', 'worker-1', 'more', quickResolver);
          await manager.flushAll();
        })(),
      ];

      const results = await Promise.all(promises);

      // All operations should complete without error
      expect(results[0]).not.toBeNull();
      expect(typeof results[1]).toBe('number');
    });

    it('should handle concurrent flushes to different workers', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'data1', quickResolver);
      manager.bufferOutput('session-1', 'worker-2', 'data2', quickResolver);
      manager.bufferOutput('session-1', 'worker-3', 'data3', quickResolver);

      await manager.flushAll();

      const content1 = vol.readFileSync(manager.getOutputFilePath('session-1', 'worker-1', quickResolver), 'utf-8');
      const content2 = vol.readFileSync(manager.getOutputFilePath('session-1', 'worker-2', quickResolver), 'utf-8');
      const content3 = vol.readFileSync(manager.getOutputFilePath('session-1', 'worker-3', quickResolver), 'utf-8');

      expect(content1).toBe('data1');
      expect(content2).toBe('data2');
      expect(content3).toBe('data3');
    });
  });

  describe('UTF-8 byte offset handling', () => {
    it('should correctly slice at byte offset with multi-byte characters', async () => {
      // Write data with emoji (4-byte UTF-8)
      const data = 'Hello 🎉 World'; // 🎉 is 4 bytes
      manager.bufferOutput('session-utf8-emoji', 'worker-1', data, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Get offset after 'Hello ' (6 bytes)
      const result = await manager.readHistoryWithOffset('session-utf8-emoji', 'worker-1', quickResolver, 6);
      // Should get '🎉 World' (emoji + rest)
      expect(result?.data).toBe('🎉 World');
    });

    it('should correctly handle CJK characters with offset', async () => {
      // Japanese: 日本語 (3 chars, 9 bytes in UTF-8)
      const data = 'ABC日本語DEF'; // A=1, B=1, C=1, 日=3, 本=3, 語=3, D=1, E=1, F=1
      manager.bufferOutput('session-utf8-cjk', 'worker-1', data, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Offset at 3 should give us '日本語DEF'
      const result = await manager.readHistoryWithOffset('session-utf8-cjk', 'worker-1', quickResolver, 3);
      expect(result?.data).toBe('日本語DEF');
    });

    it('should handle mixed multi-byte characters correctly', async () => {
      // Mix of ASCII, CJK (3 bytes), and emoji (4 bytes)
      const data = 'A日🎉B'; // A=1, 日=3, 🎉=4, B=1 -> total 9 bytes
      manager.bufferOutput('session-utf8-mixed', 'worker-1', data, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Offset at 1 should give us '日🎉B'
      const result1 = await manager.readHistoryWithOffset('session-utf8-mixed', 'worker-1', quickResolver, 1);
      expect(result1?.data).toBe('日🎉B');

      // Offset at 4 (after A and 日) should give us '🎉B'
      const result2 = await manager.readHistoryWithOffset('session-utf8-mixed', 'worker-1', quickResolver, 4);
      expect(result2?.data).toBe('🎉B');

      // Offset at 8 (after A, 日, and 🎉) should give us 'B'
      const result3 = await manager.readHistoryWithOffset('session-utf8-mixed', 'worker-1', quickResolver, 8);
      expect(result3?.data).toBe('B');
    });
  });

  describe('race condition prevention', () => {
    it('getCurrentOffset should flush pending buffer first', async () => {
      // Buffer data without waiting for flush
      manager.bufferOutput('session-race-1', 'worker-1', 'test data', quickResolver);

      // getCurrentOffset should flush first, so offset includes the buffered data
      const offset = await manager.getCurrentOffset('session-race-1', 'worker-1', quickResolver);
      expect(offset).toBe(9); // 'test data'.length

      // Verify data is in file (not in pending buffer)
      const result = await manager.readHistoryWithOffset('session-race-1', 'worker-1', quickResolver);
      expect(result?.data).toBe('test data');
      expect(result?.offset).toBe(9);
    });

    it('should return consistent offset even with rapid buffer writes', async () => {
      // Rapidly write multiple chunks
      manager.bufferOutput('session-race-2', 'worker-1', 'chunk1', quickResolver);
      manager.bufferOutput('session-race-2', 'worker-1', 'chunk2', quickResolver);
      manager.bufferOutput('session-race-2', 'worker-1', 'chunk3', quickResolver);

      // getCurrentOffset should flush and return accurate total
      const offset = await manager.getCurrentOffset('session-race-2', 'worker-1', quickResolver);
      expect(offset).toBe(18); // 'chunk1chunk2chunk3'.length
    });

    it('should handle interleaved buffer and getCurrentOffset calls', async () => {
      // First write
      manager.bufferOutput('session-race-3', 'worker-1', 'first', quickResolver);
      const offset1 = await manager.getCurrentOffset('session-race-3', 'worker-1', quickResolver);
      expect(offset1).toBe(5);

      // Second write
      manager.bufferOutput('session-race-3', 'worker-1', 'second', quickResolver);
      const offset2 = await manager.getCurrentOffset('session-race-3', 'worker-1', quickResolver);
      expect(offset2).toBe(11); // 'firstsecond'.length
    });
  });

  describe('UTF-8 safe truncation', () => {
    it('should find safe UTF-8 boundary when truncating', async () => {
      // Create a string that when truncated might cut through a multi-byte char
      // Use Japanese characters (3 bytes each)
      const chars = 'あ'.repeat(100); // 300 bytes
      manager.bufferOutput('session-trunc-utf8', 'worker-1', chars, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify file exists and read it
      const result = await manager.readHistoryWithOffset('session-trunc-utf8', 'worker-1', quickResolver);
      expect(result?.data).toBe(chars);
    });

    it('should preserve UTF-8 integrity after truncation with mixed characters', async () => {
      // Write enough data to trigger truncation (max is 1024 bytes)
      // Use a mix of ASCII and multi-byte characters
      const repeatedPattern = 'テスト'; // 9 bytes per iteration (3 chars x 3 bytes)
      const largeData = repeatedPattern.repeat(150); // 1350 bytes, exceeds 1024

      manager.bufferOutput('session-trunc-mixed', 'worker-1', largeData, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-trunc-mixed', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8') as string;

      // File should be truncated
      expect(content.length).toBeLessThan(largeData.length);

      // Content should be valid UTF-8 (no garbled characters)
      // Each character should be 'テ', 'ス', or 'ト'
      for (const char of content) {
        expect(['テ', 'ス', 'ト']).toContain(char);
      }
    });

    it('should handle truncation with emoji characters', async () => {
      // Create data with emoji that would trigger truncation
      const emoji = '🎉'; // 4 bytes
      const largeData = emoji.repeat(300); // 1200 bytes, exceeds 1024

      manager.bufferOutput('session-trunc-emoji', 'worker-1', largeData, quickResolver);
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-trunc-emoji', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8') as string;

      // File should be truncated
      expect(content.length).toBeLessThan(largeData.length);

      // All characters should be the same emoji (no corruption)
      for (const char of [...content]) {
        expect(char).toBe('🎉');
      }
    });
  });

  describe('async error handling', () => {
    it('should log error but not throw when flush fails on threshold', async () => {
      // This test ensures errors are caught and logged, not thrown
      // The fix ensures errors are caught and logged, not thrown
      // For now, ensure normal operation works
      const largeData = 'x'.repeat(TEST_WORKER_OUTPUT_FLUSH_THRESHOLD + 1);

      // This should trigger immediate flush due to threshold
      expect(() => {
        manager.bufferOutput('session-error-1', 'worker-1', largeData, quickResolver);
      }).not.toThrow();

      // Wait for async flush to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify data was written correctly
      const filePath = manager.getOutputFilePath('session-error-1', 'worker-1', quickResolver);
      expect(vol.existsSync(filePath)).toBe(true);
    });

    it('should handle multiple threshold-exceeding writes without throwing', async () => {
      // Simulate multiple rapid large writes that would each trigger immediate flush
      const largeChunk = 'y'.repeat(TEST_WORKER_OUTPUT_FLUSH_THRESHOLD + 1);

      // Multiple rapid writes - should not throw
      expect(() => {
        manager.bufferOutput('session-error-2', 'worker-1', largeChunk, quickResolver);
        manager.bufferOutput('session-error-2', 'worker-1', largeChunk, quickResolver);
        manager.bufferOutput('session-error-2', 'worker-1', largeChunk, quickResolver);
      }).not.toThrow();

      // Wait for async flushes to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // File should exist with data (may be truncated due to max size)
      const filePath = manager.getOutputFilePath('session-error-2', 'worker-1', quickResolver);
      expect(vol.existsSync(filePath)).toBe(true);
    });

    it('should continue buffering after threshold flush completes', async () => {
      // Write data exceeding threshold
      const largeData = 'z'.repeat(TEST_WORKER_OUTPUT_FLUSH_THRESHOLD + 1);
      manager.bufferOutput('session-error-3', 'worker-1', largeData, quickResolver);

      // Wait for threshold flush
      await new Promise(resolve => setTimeout(resolve, 50));

      // Buffer more data
      manager.bufferOutput('session-error-3', 'worker-1', 'additional', quickResolver);

      // Wait for timer flush
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = manager.getOutputFilePath('session-error-3', 'worker-1', quickResolver);
      const content = vol.readFileSync(filePath, 'utf-8') as string;

      // Should contain both the large data and additional data
      expect(content).toContain('additional');
    });
  });

  describe('readLastNLines', () => {
    it('should return last N lines from file', async () => {
      const filePath = manager.getOutputFilePath('session-lines', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-lines`, { recursive: true });
      vol.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');

      const result = await manager.readLastNLines('session-lines', 'worker-1', 3, quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('line3\nline4\nline5');
      // Offset should be full file size
      expect(result!.offset).toBe(29);
    });

    it('should return all lines if file has fewer than maxLines', async () => {
      const filePath = manager.getOutputFilePath('session-lines-2', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-lines-2`, { recursive: true });
      vol.writeFileSync(filePath, 'line1\nline2');

      const result = await manager.readLastNLines('session-lines-2', 'worker-1', 10, quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('line1\nline2');
    });

    it('should handle CRLF line endings', async () => {
      const filePath = manager.getOutputFilePath('session-crlf', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-crlf`, { recursive: true });
      vol.writeFileSync(filePath, 'line1\r\nline2\r\nline3\r\nline4');

      const result = await manager.readLastNLines('session-crlf', 'worker-1', 2, quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('line3\r\nline4');
    });

    it('should handle empty lines in count', async () => {
      const filePath = manager.getOutputFilePath('session-empty', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-empty`, { recursive: true });
      vol.writeFileSync(filePath, 'line1\n\nline3\nline4');

      const result = await manager.readLastNLines('session-empty', 'worker-1', 3, quickResolver);

      expect(result).not.toBeNull();
      // Empty line counts as a line
      expect(result!.data).toBe('\nline3\nline4');
    });

    it('should return empty history for non-existent file with no buffer', async () => {
      const result = await manager.readLastNLines('nonexistent', 'worker-1', 5, quickResolver);
      // Returns empty history instead of null to support newly created workers
      expect(result).not.toBeNull();
      expect(result!.data).toBe('');
      expect(result!.offset).toBe(0);
    });

    it('should apply line limit to pending buffer', async () => {
      manager.bufferOutput('session-buffer-lines', 'worker-1', 'line1\nline2\nline3\nline4', quickResolver);

      const result = await manager.readLastNLines('session-buffer-lines', 'worker-1', 2, quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('line3\nline4');
    });

    it('should return 0 lines when maxLines is 0', async () => {
      const filePath = manager.getOutputFilePath('session-zero', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-zero`, { recursive: true });
      vol.writeFileSync(filePath, 'line1\nline2');

      const result = await manager.readLastNLines('session-zero', 'worker-1', 0, quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('');
    });

    it('should preserve newline at end of content', async () => {
      const filePath = manager.getOutputFilePath('session-trailing', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-trailing`, { recursive: true });
      vol.writeFileSync(filePath, 'line1\nline2\nline3\n');

      const result = await manager.readLastNLines('session-trailing', 'worker-1', 2, quickResolver);

      expect(result).not.toBeNull();
      // Last 2 lines: "line3" and empty line after last \n
      expect(result!.data).toBe('line3\n');
    });

    it('should include pending buffer when file exists', async () => {
      const filePath = manager.getOutputFilePath('session-pending-file', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-pending-file`, { recursive: true });
      vol.writeFileSync(filePath, 'line1\nline2\nline3'); // 17 bytes

      // Buffer more data (not flushed yet)
      manager.bufferOutput('session-pending-file', 'worker-1', '\nline4\nline5', quickResolver); // 12 bytes

      const result = await manager.readLastNLines('session-pending-file', 'worker-1', 3, quickResolver);

      expect(result).not.toBeNull();
      // Should get last 3 lines from combined content (file + pending)
      expect(result!.data).toBe('line3\nline4\nline5');
      // Offset should be file size (17) + pending buffer byte length (12)
      expect(result!.offset).toBe(29);
    });

    it('should include pending buffer even when fewer lines requested', async () => {
      const filePath = manager.getOutputFilePath('session-pending-fewer', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-pending-fewer`, { recursive: true });
      vol.writeFileSync(filePath, 'old1\nold2\nold3'); // 14 bytes

      // Buffer more data that contains the most recent output (not flushed yet)
      manager.bufferOutput('session-pending-fewer', 'worker-1', '\nnew1\nnew2', quickResolver); // 10 bytes

      // Request only last 2 lines - should be from pending buffer
      const result = await manager.readLastNLines('session-pending-fewer', 'worker-1', 2, quickResolver);

      expect(result).not.toBeNull();
      expect(result!.data).toBe('new1\nnew2');
      // Offset should be file size (14) + pending buffer byte length (10)
      expect(result!.offset).toBe(24);
    });

    it('should handle pending buffer with multi-byte UTF-8 characters', async () => {
      const filePath = manager.getOutputFilePath('session-pending-utf8', 'worker-1', quickResolver);
      vol.mkdirSync(`${TEST_CONFIG_DIR}/_quick/outputs/session-pending-utf8`, { recursive: true });
      vol.writeFileSync(filePath, 'hello\n'); // 6 bytes

      // Buffer Japanese characters (3 bytes each)
      manager.bufferOutput('session-pending-utf8', 'worker-1', 'テスト', quickResolver); // 9 bytes

      const result = await manager.readLastNLines('session-pending-utf8', 'worker-1', 2, quickResolver);

      expect(result).not.toBeNull();
      // Last 2 lines: "hello" and "テスト"
      expect(result!.data).toBe('hello\nテスト');
      // Offset should be file size (6) + pending buffer byte length (9)
      expect(result!.offset).toBe(15);
    });
  });

  describe('repository-scoped paths', () => {
    it('should return repository-scoped path when repositoryName is provided', () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', repoResolver);
      expect(filePath).toBe(`${TEST_CONFIG_DIR}/repositories/org/repo/outputs/session-1/worker-1.log`);
    });

    it('should initialize worker output under repository path when repositoryName is provided', async () => {
      await manager.initializeWorkerOutput('session-1', 'worker-1', repoResolver);

      const filePath = `${TEST_CONFIG_DIR}/repositories/org/repo/outputs/session-1/worker-1.log`;
      expect(vol.existsSync(filePath)).toBe(true);
    });

    it('should flush buffered output to repository-scoped path when repositoryName is provided', async () => {
      manager.bufferOutput('session-1', 'worker-1', 'repo data', repoResolver);

      // Wait for flush interval
      await new Promise(resolve => setTimeout(resolve, 150));

      const filePath = `${TEST_CONFIG_DIR}/repositories/org/repo/outputs/session-1/worker-1.log`;
      expect(vol.existsSync(filePath)).toBe(true);

      const content = vol.readFileSync(filePath, 'utf-8');
      expect(content).toBe('repo data');
    });

    it('should delete session outputs from repository-scoped path when repositoryName is provided', async () => {
      await manager.initializeWorkerOutput('session-1', 'worker-1', repoResolver);
      const sessionDir = `${TEST_CONFIG_DIR}/repositories/org/repo/outputs/session-1`;
      expect(vol.existsSync(sessionDir)).toBe(true);

      await manager.deleteSessionOutputs('session-1', repoResolver);
      expect(vol.existsSync(sessionDir)).toBe(false);
    });

    it('should use _quick fallback when repositoryName is not provided', () => {
      const filePath = manager.getOutputFilePath('session-1', 'worker-1', quickResolver);
      expect(filePath).toBe(`${TEST_CONFIG_DIR}/_quick/outputs/session-1/worker-1.log`);
    });
  });
});
