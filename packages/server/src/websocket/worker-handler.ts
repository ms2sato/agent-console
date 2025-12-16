import type { WSContext } from 'hono/ws';
import type { WorkerClientMessage } from '@agent-console/shared';
import { sessionManager as defaultSessionManager } from '../services/session-manager.js';
import { writeFileSync as defaultWriteFileSync, mkdirSync as defaultMkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as defaultTmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('worker-handler');

/**
 * Dependencies for worker handler (enables dependency injection for testing)
 */
export interface WorkerHandlerDependencies {
  sessionManager: {
    writeWorkerInput: (sessionId: string, workerId: string, data: string) => void;
    resizeWorker: (sessionId: string, workerId: string, cols: number, rows: number) => void;
  };
  writeFileSync: typeof defaultWriteFileSync;
  mkdirSync: typeof defaultMkdirSync;
  tmpdir: typeof defaultTmpdir;
}

const defaultDeps: WorkerHandlerDependencies = {
  sessionManager: defaultSessionManager,
  writeFileSync: defaultWriteFileSync,
  mkdirSync: defaultMkdirSync,
  tmpdir: defaultTmpdir,
};

function getExtensionFromMimeType(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
  };
  return mimeMap[mimeType] || 'png';
}

/**
 * Create a worker message handler with the given dependencies
 */
export function createWorkerMessageHandler(deps: Partial<WorkerHandlerDependencies> = {}) {
  const { sessionManager, writeFileSync, mkdirSync, tmpdir } = { ...defaultDeps, ...deps };

  // Directory for storing uploaded images
  const IMAGE_UPLOAD_DIR = join(tmpdir(), 'agent-console-images');

  // Ensure image upload directory exists
  try {
    mkdirSync(IMAGE_UPLOAD_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }

  return function handleWorkerMessage(
    _ws: WSContext,
    sessionId: string,
    workerId: string,
    message: string | ArrayBuffer
  ): void {
    try {
      const msgStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const parsed: WorkerClientMessage = JSON.parse(msgStr);

      switch (parsed.type) {
        case 'input':
          sessionManager.writeWorkerInput(sessionId, workerId, parsed.data);
          break;
        case 'resize':
          sessionManager.resizeWorker(sessionId, workerId, parsed.cols, parsed.rows);
          break;
        case 'image': {
          // Save image to temp file
          const ext = getExtensionFromMimeType(parsed.mimeType);
          const filename = `${randomUUID()}.${ext}`;
          const filePath = join(IMAGE_UPLOAD_DIR, filename);

          // Decode base64 and write to file
          const buffer = Buffer.from(parsed.data, 'base64');
          writeFileSync(filePath, buffer);

          logger.debug({ filePath }, 'Image saved');

          // Send file path to PTY stdin (Claude Code will read the image)
          sessionManager.writeWorkerInput(sessionId, workerId, filePath);
          break;
        }
      }
    } catch (e) {
      logger.warn({ err: e, sessionId, workerId }, 'Invalid worker message');
    }
  };
}

// Default handler for backward compatibility
export const handleWorkerMessage = createWorkerMessageHandler();
