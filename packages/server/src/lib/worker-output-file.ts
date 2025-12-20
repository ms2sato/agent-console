/**
 * File-based output persistence for terminal workers.
 * Supports large output history (up to 10MB) with incremental sync.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { getConfigDir } from './config.js';
import { serverConfig } from './server-config.js';
import { createLogger } from './logger.js';

const logger = createLogger('worker-output-file');

/**
 * Result of reading history with offset
 */
export interface HistoryReadResult {
  /** The output data read from file */
  data: string;
  /** Current file offset (file size) for incremental sync */
  offset: number;
}

/**
 * Pending flush info for a worker
 */
interface PendingFlush {
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Manages file-based output persistence for workers.
 * Uses buffering to reduce file I/O frequency.
 */
export class WorkerOutputFileManager {
  /** Pending buffers waiting to be flushed: sessionId/workerId -> PendingFlush */
  private pendingFlushes = new Map<string, PendingFlush>();

  /**
   * Get the output file path for a worker.
   * Structure: ${AGENT_CONSOLE_HOME}/outputs/${sessionId}/${workerId}.log
   */
  getOutputFilePath(sessionId: string, workerId: string): string {
    return path.join(getConfigDir(), 'outputs', sessionId, `${workerId}.log`);
  }

  /**
   * Get the key for tracking pending flushes.
   */
  private getKey(sessionId: string, workerId: string): string {
    return `${sessionId}/${workerId}`;
  }

  /**
   * Buffer output data for periodic flushing to file.
   * Flushes immediately if buffer exceeds threshold.
   */
  bufferOutput(sessionId: string, workerId: string, data: string): void {
    const key = this.getKey(sessionId, workerId);
    let pending = this.pendingFlushes.get(key);

    if (!pending) {
      pending = { buffer: '', timer: null };
      this.pendingFlushes.set(key, pending);
    }

    pending.buffer += data;

    // Flush immediately if buffer exceeds threshold
    if (pending.buffer.length >= serverConfig.WORKER_OUTPUT_FLUSH_THRESHOLD) {
      void this.flushBuffer(sessionId, workerId).catch((err) => {
        logger.error({ sessionId, workerId, err }, 'Failed to flush buffer on threshold');
      });
      return;
    }

    // Schedule flush if not already scheduled
    if (!pending.timer) {
      pending.timer = setTimeout(() => {
        void this.flushBuffer(sessionId, workerId).catch((err) => {
          logger.error({ sessionId, workerId, err }, 'Failed to flush buffer on timer');
        });
      }, serverConfig.WORKER_OUTPUT_FLUSH_INTERVAL);
    }
  }

  /**
   * Flush buffered output to file.
   * Also enforces max file size by truncating from the beginning.
   */
  private async flushBuffer(sessionId: string, workerId: string): Promise<void> {
    const key = this.getKey(sessionId, workerId);
    const pending = this.pendingFlushes.get(key);

    if (!pending || pending.buffer.length === 0) {
      return;
    }

    // Clear timer and get buffer content
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const dataToWrite = pending.buffer;
    pending.buffer = '';

    const filePath = this.getOutputFilePath(sessionId, workerId);

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Append data to file
      await fs.appendFile(filePath, dataToWrite, 'utf-8');

      // Check file size and truncate if necessary
      const stats = await fs.stat(filePath);
      if (stats.size > serverConfig.WORKER_OUTPUT_FILE_MAX_SIZE) {
        await this.truncateFile(filePath, stats.size);
      }
    } catch (error) {
      logger.error({ sessionId, workerId, err: error }, 'Failed to flush output to file');
    }
  }

  /**
   * Truncate file from the beginning to stay within max size.
   * Keeps the most recent data and ensures UTF-8 boundary safety.
   */
  private async truncateFile(filePath: string, currentSize: number): Promise<void> {
    const maxSize = serverConfig.WORKER_OUTPUT_FILE_MAX_SIZE;
    const targetSize = Math.floor(maxSize * 0.8); // Truncate to 80% to avoid frequent truncation

    try {
      const buffer = await fs.readFile(filePath);
      let slicePoint = currentSize - targetSize;

      // Find safe UTF-8 boundary (skip continuation bytes: 0b10xxxxxx)
      // UTF-8 continuation bytes have the pattern 10xxxxxx (0x80-0xBF)
      // We need to skip past them to find the start of a valid character
      while (slicePoint < buffer.length && (buffer[slicePoint] & 0xC0) === 0x80) {
        slicePoint++;
      }

      const trimmedBuffer = buffer.slice(slicePoint);
      await fs.writeFile(filePath, trimmedBuffer);
      logger.debug({ filePath, originalSize: currentSize, newSize: trimmedBuffer.length }, 'Truncated output file');
    } catch (error) {
      logger.error({ filePath, err: error }, 'Failed to truncate output file');
    }
  }

  /**
   * Read output history from file.
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @param fromOffset If specified, read only data after this offset (for incremental sync)
   * @returns History data and current offset, or null if file doesn't exist
   */
  async readHistoryWithOffset(
    sessionId: string,
    workerId: string,
    fromOffset?: number
  ): Promise<HistoryReadResult | null> {
    const filePath = this.getOutputFilePath(sessionId, workerId);

    try {
      // Read as Buffer for accurate byte operations (handles multi-byte UTF-8 correctly)
      const buffer = await fs.readFile(filePath);
      const currentOffset = buffer.length;

      // If fromOffset is specified and equals or exceeds current size, no new data
      if (fromOffset !== undefined && fromOffset >= currentOffset) {
        return { data: '', offset: currentOffset };
      }

      // If fromOffset specified, return only data after that offset
      if (fromOffset !== undefined && fromOffset > 0) {
        // Slice at byte level, then decode to UTF-8
        const dataBuffer = buffer.slice(fromOffset);
        return { data: dataBuffer.toString('utf-8'), offset: currentOffset };
      }

      return { data: buffer.toString('utf-8'), offset: currentOffset };
    } catch (error) {
      // File doesn't exist or read error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Also check pending buffer
        const key = this.getKey(sessionId, workerId);
        const pending = this.pendingFlushes.get(key);
        if (pending && pending.buffer.length > 0) {
          // Return pending buffer as data with byte offset (not character count)
          // File offsets are measured in bytes, so we must use byte length for consistency
          const byteLength = Buffer.byteLength(pending.buffer, 'utf-8');
          return { data: pending.buffer, offset: byteLength };
        }
        return null;
      }
      logger.error({ sessionId, workerId, err: error }, 'Failed to read output file');
      return null;
    }
  }

  /**
   * Get current file offset without reading content.
   * Flushes any pending buffer first to ensure accurate offset.
   * Returns 0 if file doesn't exist.
   */
  async getCurrentOffset(sessionId: string, workerId: string): Promise<number> {
    // Flush any pending buffer first to ensure accurate offset
    // This prevents race conditions where offset is read before buffer is flushed
    await this.flushBuffer(sessionId, workerId);

    const filePath = this.getOutputFilePath(sessionId, workerId);

    try {
      const stats = await fs.stat(filePath);
      return stats.size;  // No pending buffer to add since we just flushed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      logger.error({ sessionId, workerId, err: error }, 'Failed to get file offset');
      return 0;
    }
  }

  /**
   * Delete output file for a worker.
   */
  async deleteWorkerOutput(sessionId: string, workerId: string): Promise<void> {
    // Clear any pending flush
    const key = this.getKey(sessionId, workerId);
    const pending = this.pendingFlushes.get(key);
    if (pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pendingFlushes.delete(key);
    }

    const filePath = this.getOutputFilePath(sessionId, workerId);

    try {
      await fs.unlink(filePath);
      logger.debug({ sessionId, workerId }, 'Deleted worker output file');
    } catch (error) {
      // Ignore if file doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ sessionId, workerId, err: error }, 'Failed to delete worker output file');
      }
    }
  }

  /**
   * Delete all output files for a session.
   */
  async deleteSessionOutputs(sessionId: string): Promise<void> {
    // Clear any pending flushes for this session
    const keysToDelete: string[] = [];
    for (const [key, pending] of this.pendingFlushes) {
      if (key.startsWith(`${sessionId}/`)) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.pendingFlushes.delete(key);
    }

    const sessionDir = path.join(getConfigDir(), 'outputs', sessionId);

    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
      logger.debug({ sessionId }, 'Deleted session output directory');
    } catch (error) {
      // Ignore if directory doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ sessionId, err: error }, 'Failed to delete session output directory');
      }
    }
  }

  /**
   * Force flush all pending buffers.
   * Useful for graceful shutdown.
   */
  async flushAll(): Promise<void> {
    const flushPromises: Promise<void>[] = [];

    for (const key of this.pendingFlushes.keys()) {
      const [sessionId, workerId] = key.split('/');
      flushPromises.push(this.flushBuffer(sessionId, workerId));
    }

    await Promise.all(flushPromises);
  }
}

// Singleton instance
export const workerOutputFileManager = new WorkerOutputFileManager();
