import type { WSContext } from 'hono/ws';
import type { WorkerClientMessage } from '@agent-console/shared';
import { sessionManager } from '../services/session-manager.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Directory for storing uploaded images
const IMAGE_UPLOAD_DIR = join(tmpdir(), 'agent-console-images');

// Ensure image upload directory exists
try {
  mkdirSync(IMAGE_UPLOAD_DIR, { recursive: true });
} catch {
  // Directory may already exist
}

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

export function handleWorkerMessage(
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

        console.log(`Image saved: ${filePath}`);

        // Send file path to PTY stdin (Claude Code will read the image)
        sessionManager.writeWorkerInput(sessionId, workerId, filePath);
        break;
      }
    }
  } catch (e) {
    console.error('Invalid worker message:', e);
  }
}
