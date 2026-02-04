/**
 * File-based message persistence for SDK workers.
 * Stores SDK messages in JSONL format for recovery after server restart.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { SDKMessage } from '@agent-console/shared';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sdk-message-file-manager');

/**
 * Manages file-based message persistence for SDK workers.
 * Each message is stored as a single JSON line in a JSONL file.
 */
export class SdkMessageFileManager {
  /**
   * Get the SDK messages file path for a worker.
   * Structure: ${AGENT_CONSOLE_HOME}/sessions/${sessionId}/workers/${workerId}/sdk-messages.jsonl
   */
  getMessagesFilePath(sessionId: string, workerId: string): string {
    return path.join(
      getConfigDir(),
      'sessions',
      sessionId,
      'workers',
      workerId,
      'sdk-messages.jsonl'
    );
  }

  /**
   * Initialize (create/truncate) the messages file for a worker.
   * Call this when creating a new SDK worker.
   */
  async initializeWorkerFile(sessionId: string, workerId: string): Promise<void> {
    const filePath = this.getMessagesFilePath(sessionId, workerId);

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Create empty file (truncate if exists)
      await fs.writeFile(filePath, '', 'utf-8');

      logger.debug({ sessionId, workerId, filePath }, 'Initialized SDK messages file');
    } catch (error) {
      logger.error({ sessionId, workerId, err: error }, 'Failed to initialize SDK messages file');
      // Don't throw - file initialization failure should not block worker creation
    }
  }

  /**
   * Append a message to the worker's JSONL file.
   * Each message is written as a single JSON line.
   */
  async appendMessage(sessionId: string, workerId: string, message: SDKMessage): Promise<void> {
    const filePath = this.getMessagesFilePath(sessionId, workerId);

    try {
      // Ensure directory exists (in case file was deleted but not recreated)
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Serialize message to JSON and append with newline
      const line = JSON.stringify(message) + '\n';
      await fs.appendFile(filePath, line, 'utf-8');
    } catch (error) {
      // Log error but don't throw - message persistence failure should not crash the worker
      logger.error({ sessionId, workerId, err: error }, 'Failed to append SDK message to file');
    }
  }

  /**
   * Read all messages from a worker's JSONL file.
   * Returns an empty array if file doesn't exist or is empty.
   */
  async readMessages(sessionId: string, workerId: string): Promise<SDKMessage[]> {
    const filePath = this.getMessagesFilePath(sessionId, workerId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      if (!content.trim()) {
        return [];
      }

      const messages: SDKMessage[] = [];
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line) as SDKMessage;
          messages.push(message);
        } catch (parseError) {
          // Log and skip invalid lines, but continue processing
          logger.warn(
            { sessionId, workerId, line: line.substring(0, 100) },
            'Skipping invalid JSON line in SDK messages file'
          );
        }
      }

      logger.debug(
        { sessionId, workerId, messageCount: messages.length },
        'Read SDK messages from file'
      );

      return messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - return empty array
        return [];
      }
      logger.error({ sessionId, workerId, err: error }, 'Failed to read SDK messages file');
      return [];
    }
  }

  /**
   * Clear (delete) the worker's messages file.
   */
  async clearWorkerFile(sessionId: string, workerId: string): Promise<void> {
    const filePath = this.getMessagesFilePath(sessionId, workerId);

    try {
      await fs.unlink(filePath);
      logger.debug({ sessionId, workerId }, 'Cleared SDK messages file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ sessionId, workerId, err: error }, 'Failed to clear SDK messages file');
      }
      // ENOENT is fine - file was already deleted
    }
  }

  /**
   * Delete all SDK worker files for a session.
   * Called when a session is deleted.
   */
  async deleteSessionFiles(sessionId: string): Promise<void> {
    const sessionDir = path.join(getConfigDir(), 'sessions', sessionId);

    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
      logger.debug({ sessionId }, 'Deleted SDK session directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ sessionId, err: error }, 'Failed to delete SDK session directory');
      }
    }
  }
}

// Singleton instance
export const sdkMessageFileManager = new SdkMessageFileManager();
