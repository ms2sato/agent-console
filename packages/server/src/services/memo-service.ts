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
import { getMemosDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('memo-service');

export class MemoService {
  /**
   * Write a memo for a session. Creates the memos directory if needed
   * and writes the file atomically (write to temp, then rename).
   *
   * @returns The absolute file path of the written memo.
   */
  async writeMemo(sessionId: string, content: string): Promise<string> {
    const memosDir = getMemosDir();
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
  async readMemo(sessionId: string): Promise<string | null> {
    const filePath = path.join(getMemosDir(), `${sessionId}.md`);
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
  async deleteMemo(sessionId: string): Promise<void> {
    const filePath = path.join(getMemosDir(), `${sessionId}.md`);
    await fs.rm(filePath, { force: true });
    logger.debug({ sessionId }, 'Memo deleted');
  }
}

export const memoService = new MemoService();
