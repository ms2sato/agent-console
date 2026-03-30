/**
 * MemoService - File-based memo storage per session.
 *
 * Stateless service handling file operations only. Each session has at most
 * one memo file stored as Markdown.
 *
 * Storage path: ~/.agent-console/memos/{sessionId}.md
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('memo-service');

const MAX_MEMO_SIZE_BYTES = 256 * 1024; // 256KB

export class MemoService {
  private validateSessionId(sessionId: string): void {
    const safe = path.basename(sessionId);
    if (safe !== sessionId || sessionId.includes('..') || sessionId.includes('/')) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
  }

  /**
   * Write a memo for a session. Creates the memos directory if needed
   * and writes the file atomically (write to temp, then rename).
   *
   * @returns The absolute file path of the written memo.
   */
  async writeMemo(sessionId: string, content: string, resolver: SessionDataPathResolver): Promise<string> {
    this.validateSessionId(sessionId);
    const contentSize = Buffer.byteLength(content, 'utf-8');
    if (contentSize > MAX_MEMO_SIZE_BYTES) {
      throw new Error(`Memo content exceeds maximum size of ${MAX_MEMO_SIZE_BYTES} bytes (got ${contentSize})`);
    }

    const memosDir = resolver.getMemosDir();
    await fs.mkdir(memosDir, { recursive: true });

    const filePath = path.join(memosDir, `${sessionId}.md`);
    const tmpPath = path.join(memosDir, `.tmp-${sessionId}.md`);

    await fs.writeFile(tmpPath, content, 'utf-8');
    try {
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    logger.debug({ sessionId, filePath }, 'Memo written');
    return filePath;
  }

  /**
   * Read a memo for a session.
   *
   * @returns The memo content, or null if no memo exists.
   */
  async readMemo(sessionId: string, resolver: SessionDataPathResolver): Promise<string | null> {
    this.validateSessionId(sessionId);
    const filePath = resolver.getMemosPath(sessionId);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Delete a memo for a session. Does not throw if the file does not exist.
   */
  async deleteMemo(sessionId: string, resolver: SessionDataPathResolver): Promise<void> {
    this.validateSessionId(sessionId);
    const filePath = resolver.getMemosPath(sessionId);
    await fs.rm(filePath, { force: true });
    logger.debug({ sessionId }, 'Memo deleted');
  }
}

export const memoService = new MemoService();
