/**
 * File-based output persistence for terminal workers.
 * Supports large output history (up to 10MB) with incremental sync.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { gunzipSync } from 'bun';
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
   * Check if a file exists at the given path.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the actual file path for a worker, checking for legacy compressed files.
   * Returns { path, isCompressed } where isCompressed indicates the file format.
   * Returns null if no file exists.
   *
   * Note: Legacy .log.gz files are still supported for reading (migration compatibility).
   */
  private async getActualFilePath(sessionId: string, workerId: string): Promise<{ path: string; isCompressed: boolean } | null> {
    const uncompressedPath = path.join(getConfigDir(), 'outputs', sessionId, `${workerId}.log`);
    const compressedPath = path.join(getConfigDir(), 'outputs', sessionId, `${workerId}.log.gz`);

    // Check uncompressed file first (current format)
    if (await this.fileExists(uncompressedPath)) {
      return { path: uncompressedPath, isCompressed: false };
    }

    // Check legacy compressed file
    if (await this.fileExists(compressedPath)) {
      return { path: compressedPath, isCompressed: true };
    }

    return null;
  }

  /**
   * Get the key for tracking pending flushes.
   */
  private getKey(sessionId: string, workerId: string): string {
    return `${sessionId}/${workerId}`;
  }

  /**
   * Initialize an empty output file for a worker.
   * Call this immediately when creating a new worker to ensure history file exists.
   * This prevents race conditions where WebSocket connects before any output is buffered.
   */
  async initializeWorkerOutput(sessionId: string, workerId: string): Promise<void> {
    const filePath = this.getOutputFilePath(sessionId, workerId);

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Check if file already exists (e.g., from previous run)
      const actualFile = await this.getActualFilePath(sessionId, workerId);
      if (actualFile) {
        // File already exists, no need to initialize
        return;
      }

      // Create empty file
      await fs.writeFile(filePath, '', 'utf-8');

      logger.debug({ sessionId, workerId, filePath }, 'Initialized empty worker output file');
    } catch (error) {
      logger.error({ sessionId, workerId, err: error }, 'Failed to initialize worker output file');
    }
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
   *
   * Note: Legacy .log.gz files are migrated to .log on first write.
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

      // Check if we need to migrate from legacy compressed file
      const actualFile = await this.getActualFilePath(sessionId, workerId);
      if (actualFile?.isCompressed) {
        // Migrate from compressed to uncompressed
        const rawBuffer = await fs.readFile(actualFile.path);
        const decompressed = gunzipSync(rawBuffer);
        const existingContent = new TextDecoder('utf-8').decode(decompressed);

        // Write combined content to new uncompressed file
        const combinedContent = existingContent + dataToWrite;
        await fs.writeFile(filePath, combinedContent, 'utf-8');

        // Delete the old compressed file
        await fs.unlink(actualFile.path).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn({ sessionId, workerId, path: actualFile.path, err }, 'Failed to delete legacy compressed file during migration');
          }
        });

        // Check file size and truncate if necessary
        const stats = await fs.stat(filePath);
        if (stats.size > serverConfig.WORKER_OUTPUT_FILE_MAX_SIZE) {
          await this.truncateFile(filePath, stats.size);
        }
      } else {
        // Simple append to uncompressed file
        await fs.appendFile(filePath, dataToWrite, 'utf-8');

        // Check file size and truncate if necessary
        const stats = await fs.stat(filePath);
        if (stats.size > serverConfig.WORKER_OUTPUT_FILE_MAX_SIZE) {
          await this.truncateFile(filePath, stats.size);
        }
      }
    } catch (error) {
      logger.error({ sessionId, workerId, err: error }, 'Failed to flush output to file');
    }
  }

  /**
   * Truncate file from the beginning to stay within max size.
   * Keeps the most recent data and ensures UTF-8 boundary safety.
   * @param filePath Path to the file
   * @param currentSize Current size of the file
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
   * Supports legacy .log.gz files for backward compatibility.
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @param fromOffset If specified, read only data after this offset (for incremental sync)
   * @returns History data and current offset (returns empty history if file doesn't exist)
   */
  async readHistoryWithOffset(
    sessionId: string,
    workerId: string,
    fromOffset?: number
  ): Promise<HistoryReadResult> {
    try {
      // Get pending buffer for this worker
      const key = this.getKey(sessionId, workerId);
      const pending = this.pendingFlushes.get(key);
      const pendingBuffer = pending?.buffer || '';
      const pendingByteLength = Buffer.byteLength(pendingBuffer, 'utf-8');

      // Find the actual file (uncompressed or legacy compressed)
      const actualFile = await this.getActualFilePath(sessionId, workerId);

      if (!actualFile) {
        // No file exists, return only pending buffer
        if (pendingByteLength > 0) {
          // Return pending buffer as data with byte offset (not character count)
          // File offsets are measured in bytes, so we must use byte length for consistency
          return { data: pendingBuffer, offset: pendingByteLength };
        }
        // No file and no pending buffer - return empty history
        // This is a valid state for newly created workers
        return { data: '', offset: 0 };
      }

      // Read the file and decompress if legacy compressed file
      const rawBuffer = await fs.readFile(actualFile.path);
      const buffer = actualFile.isCompressed
        ? Buffer.from(gunzipSync(rawBuffer))
        : rawBuffer;

      const fileSize = buffer.length;
      const totalOffset = fileSize + pendingByteLength;

      // Handle offset-based reads (incremental sync)
      if (fromOffset !== undefined && fromOffset > 0) {
        if (fromOffset >= totalOffset) {
          // Offset equals or exceeds total size, no new data
          return { data: '', offset: totalOffset };
        }

        if (fromOffset >= fileSize) {
          // Offset is within the pending buffer range
          // Calculate how many bytes into the pending buffer to skip
          const pendingSkipBytes = fromOffset - fileSize;
          // We need to slice the pending buffer at byte boundary
          const pendingBufferAsBuffer = Buffer.from(pendingBuffer, 'utf-8');
          const remainingPendingBuffer = pendingBufferAsBuffer.slice(pendingSkipBytes);
          return { data: remainingPendingBuffer.toString('utf-8'), offset: totalOffset };
        }

        // Offset is within the file, return file data from offset + full pending buffer
        const dataBuffer = buffer.slice(fromOffset);
        const fileData = dataBuffer.toString('utf-8');
        return { data: fileData + pendingBuffer, offset: totalOffset };
      }

      // Initial load (fromOffset=0 or undefined), return full file content + pending buffer
      return { data: buffer.toString('utf-8') + pendingBuffer, offset: totalOffset };
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
        // No file and no pending buffer - return empty history
        return { data: '', offset: 0 };
      }
      logger.error({ sessionId, workerId, err: error }, 'Failed to read output file');
      // Return empty history on error to avoid breaking the client
      return { data: '', offset: 0 };
    }
  }

  /**
   * Read the last N lines from output history.
   * Supports legacy .log.gz files for backward compatibility.
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @param maxLines Maximum number of lines to return (from the end)
   * @returns History data and current offset (returns empty history if file doesn't exist)
   */
  async readLastNLines(
    sessionId: string,
    workerId: string,
    maxLines: number
  ): Promise<HistoryReadResult> {
    try {
      // Get pending buffer for this worker
      const key = this.getKey(sessionId, workerId);
      const pending = this.pendingFlushes.get(key);
      const pendingBuffer = pending?.buffer || '';
      const pendingByteLength = Buffer.byteLength(pendingBuffer, 'utf-8');

      // Find the actual file (uncompressed or legacy compressed)
      const actualFile = await this.getActualFilePath(sessionId, workerId);

      if (!actualFile) {
        // No file exists, return only pending buffer
        if (pendingByteLength > 0) {
          // Apply line limit to pending buffer
          const trimmedData = this.getLastNLines(pendingBuffer, maxLines);
          return { data: trimmedData, offset: pendingByteLength };
        }
        // No file and no pending buffer - return empty history
        // This is a valid state for newly created workers
        return { data: '', offset: 0 };
      }

      // Read the file and decompress if legacy compressed file
      const rawBuffer = await fs.readFile(actualFile.path);
      const buffer = actualFile.isCompressed
        ? Buffer.from(gunzipSync(rawBuffer))
        : rawBuffer;

      const fileSize = buffer.length;
      const totalOffset = fileSize + pendingByteLength;

      // Combine file content with pending buffer
      const fullContent = buffer.toString('utf-8') + pendingBuffer;

      // Get last N lines from combined content
      const trimmedData = this.getLastNLines(fullContent, maxLines);

      return { data: trimmedData, offset: totalOffset };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const key = this.getKey(sessionId, workerId);
        const pending = this.pendingFlushes.get(key);
        if (pending && pending.buffer.length > 0) {
          const byteLength = Buffer.byteLength(pending.buffer, 'utf-8');
          const trimmedData = this.getLastNLines(pending.buffer, maxLines);
          return { data: trimmedData, offset: byteLength };
        }
        // No file and no pending buffer - return empty history
        return { data: '', offset: 0 };
      }
      logger.error({ sessionId, workerId, err: error }, 'Failed to read output file for last N lines');
      // Return empty history on error to avoid breaking the client
      return { data: '', offset: 0 };
    }
  }

  /**
   * Get the last N lines from a string.
   * Handles both \n and \r\n line endings.
   * Empty lines are preserved in the count.
   */
  private getLastNLines(content: string, maxLines: number): string {
    if (maxLines <= 0) {
      return '';
    }

    // Split by newlines, handling both \n and \r\n
    // Use a regex that captures line endings to preserve them
    const lines = content.split(/(\r?\n)/);

    // The split includes separators, so we need to reconstruct
    // Each pair of [content, separator] represents one line
    // Example: "a\nb\nc" -> ["a", "\n", "b", "\n", "c"]
    // We want to count actual lines, not elements

    // Count actual lines (content elements at even indices)
    let lineCount = 0;
    for (let i = 0; i < lines.length; i += 2) {
      lineCount++;
    }

    if (lineCount <= maxLines) {
      return content;
    }

    // Calculate how many lines to skip
    const linesToSkip = lineCount - maxLines;

    // Find the starting position after skipping lines
    let currentLine = 0;
    let startIndex = 0;

    for (let i = 0; i < lines.length && currentLine < linesToSkip; i += 2) {
      // Skip the content
      startIndex += lines[i].length;
      // Skip the separator if it exists
      if (i + 1 < lines.length) {
        startIndex += lines[i + 1].length;
      }
      currentLine++;
    }

    return content.slice(startIndex);
  }

  /**
   * Get current file offset without reading content.
   * Flushes any pending buffer first to ensure accurate offset.
   * Returns 0 if file doesn't exist.
   * Supports legacy .log.gz files for backward compatibility.
   */
  async getCurrentOffset(sessionId: string, workerId: string): Promise<number> {
    // Flush any pending buffer first to ensure accurate offset
    // This prevents race conditions where offset is read before buffer is flushed
    await this.flushBuffer(sessionId, workerId);

    try {
      const actualFile = await this.getActualFilePath(sessionId, workerId);
      if (!actualFile) {
        return 0;
      }

      if (actualFile.isCompressed) {
        // For legacy compressed files, decompress to get the actual content size
        const compressedBuffer = await fs.readFile(actualFile.path);
        const decompressed = gunzipSync(compressedBuffer);
        return decompressed.length;
      } else {
        // For uncompressed files, file size equals content size
        const stats = await fs.stat(actualFile.path);
        return stats.size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      logger.error({ sessionId, workerId, err: error }, 'Failed to get file offset');
      return 0;
    }
  }

  /**
   * Reset output file for a worker (clear content and start fresh).
   * Used when restarting a worker to prevent offset mismatch with client cache.
   * Clears pending buffers and creates an empty file.
   */
  async resetWorkerOutput(sessionId: string, workerId: string): Promise<void> {
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
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Delete any existing files (both compressed and uncompressed)
      const compressedPath = path.join(path.dirname(filePath), `${workerId}.log.gz`);
      await fs.unlink(compressedPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ sessionId, workerId, path: compressedPath, err }, 'Failed to delete compressed file during reset');
        }
      });
      await fs.unlink(filePath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ sessionId, workerId, path: filePath, err }, 'Failed to delete output file during reset');
        }
      });

      // Create empty file
      await fs.writeFile(filePath, '', 'utf-8');

      logger.debug({ sessionId, workerId, filePath }, 'Reset worker output file');
    } catch (error) {
      logger.error({ sessionId, workerId, err: error }, 'Failed to reset worker output file');
    }
  }

  /**
   * Delete output file for a worker.
   * Also deletes legacy .log.gz files if present.
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

    // Delete both possible file formats
    const compressedPath = path.join(getConfigDir(), 'outputs', sessionId, `${workerId}.log.gz`);
    const uncompressedPath = path.join(getConfigDir(), 'outputs', sessionId, `${workerId}.log`);

    const deleteFile = async (filePath: string): Promise<boolean> => {
      try {
        await fs.unlink(filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.error({ sessionId, workerId, filePath, err: error }, 'Failed to delete worker output file');
        }
        return false;
      }
    };

    const [deletedCompressed, deletedUncompressed] = await Promise.all([
      deleteFile(compressedPath),
      deleteFile(uncompressedPath),
    ]);

    if (deletedCompressed || deletedUncompressed) {
      logger.debug({ sessionId, workerId }, 'Deleted worker output file');
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
