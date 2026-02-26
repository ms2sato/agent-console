/**
 * InterSessionMessageService - File-based inter-session messaging.
 *
 * Stateless service handling file operations only. No knowledge of sessions,
 * workers, or PTY. Writes message files atomically (write to temp, then rename)
 * to ensure concurrent safety.
 *
 * Directory structure:
 *   ~/.agent-console/messages/{sessionId}/{workerId}/{timestamp}-{fromSessionId}.json
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getMessagesDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('inter-session-message');

/**
 * Validate that an ID contains only safe characters and cannot be used
 * for path traversal. Allows alphanumeric characters, dots, hyphens,
 * and underscores, but rejects dots-only strings like "." and "..".
 */
export function validateId(id: string, paramName: string): void {
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id) || /^\.+$/.test(id)) {
    throw new Error(`Invalid ${paramName}: contains disallowed characters`);
  }
}

/**
 * Assert that a resolved path is within the expected base directory.
 * Prevents path traversal even if validation is somehow bypassed.
 */
function assertWithinDir(resolvedPath: string, baseDir: string): void {
  const resolvedBase = path.resolve(baseDir);
  if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
    throw new Error('Path escapes the messages directory');
  }
}

export interface SendMessageParams {
  toSessionId: string;
  toWorkerId: string;
  fromSessionId: string;
  content: string;
}

export interface SendMessageResult {
  /** Filename: {timestamp}-{senderSessionId}.json */
  messageId: string;
  /** Absolute path to the message file */
  path: string;
}

export class InterSessionMessageService {
  /**
   * Write a message file for the target worker.
   *
   * 1. Create directory: {messagesDir}/{toSessionId}/{toWorkerId}/ (recursive)
   * 2. Write to temp file `.tmp-{messageId}` in the same directory
   * 3. Atomic rename to `{timestamp}-{fromSessionId}.json`
   * 4. Return { messageId, path }
   */
  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const { toSessionId, toWorkerId, fromSessionId, content } = params;

    validateId(toSessionId, 'toSessionId');
    validateId(toWorkerId, 'toWorkerId');
    validateId(fromSessionId, 'fromSessionId');

    const messagesDir = getMessagesDir();
    const dir = path.resolve(messagesDir, toSessionId, toWorkerId);
    assertWithinDir(dir, messagesDir);

    await fs.mkdir(dir, { recursive: true });

    const timestamp = Date.now();
    const suffix = randomBytes(4).toString('hex');
    const messageId = `${timestamp}-${fromSessionId}-${suffix}.json`;
    const finalPath = path.join(dir, messageId);
    const tmpPath = path.join(dir, `.tmp-${messageId}`);

    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, finalPath);

    logger.debug(
      { toSessionId, toWorkerId, fromSessionId, messageId },
      'Message file written',
    );

    return { messageId, path: finalPath };
  }

  /**
   * Remove all message files for a session.
   * Called when a session is deleted.
   */
  async deleteSessionMessages(sessionId: string): Promise<void> {
    validateId(sessionId, 'sessionId');

    const messagesDir = getMessagesDir();
    const dir = path.resolve(messagesDir, sessionId);
    assertWithinDir(dir, messagesDir);

    // force: true already suppresses ENOENT when no messages were ever sent
    await fs.rm(dir, { recursive: true, force: true });
    logger.debug({ sessionId }, 'Session message directory removed');
  }

  /**
   * Remove all message files for a specific worker within a session.
   * Called when a worker is deleted.
   */
  async deleteWorkerMessages(sessionId: string, workerId: string): Promise<void> {
    validateId(sessionId, 'sessionId');
    validateId(workerId, 'workerId');

    const messagesDir = getMessagesDir();
    const dir = path.resolve(messagesDir, sessionId, workerId);
    assertWithinDir(dir, messagesDir);

    // force: true already suppresses ENOENT when no messages were ever sent
    await fs.rm(dir, { recursive: true, force: true });
    logger.debug({ sessionId, workerId }, 'Worker message directory removed');
  }
}

export const interSessionMessageService = new InterSessionMessageService();
