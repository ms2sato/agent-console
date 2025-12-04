import type { WSContext } from 'hono/ws';
import type { TerminalClientMessage, TerminalServerMessage } from '@agents-web-console/shared';
import { sessionManager } from '../services/session-manager.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function handleTerminalConnection(
  ws: WSContext,
  sessionId: string
): void {
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    const errorMsg: TerminalServerMessage = {
      type: 'exit',
      exitCode: 1,
      signal: null,
    };
    ws.send(JSON.stringify(errorMsg));
    ws.close();
    return;
  }

  console.log(`Terminal WebSocket connected for session: ${sessionId}`);

  // Send buffered output (history) on reconnection
  const history = sessionManager.getOutputBuffer(sessionId);
  if (history) {
    const historyMsg: TerminalServerMessage = {
      type: 'history',
      data: history,
    };
    ws.send(JSON.stringify(historyMsg));
  }
}

// Directory for storing uploaded images
const IMAGE_UPLOAD_DIR = join(tmpdir(), 'agents-web-console-images');

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

export function handleTerminalMessage(
  _ws: WSContext,
  sessionId: string,
  message: string | ArrayBuffer
): void {
  try {
    const msgStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const parsed: TerminalClientMessage = JSON.parse(msgStr);

    switch (parsed.type) {
      case 'input':
        sessionManager.writeInput(sessionId, parsed.data);
        break;
      case 'resize':
        sessionManager.resize(sessionId, parsed.cols, parsed.rows);
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
        sessionManager.writeInput(sessionId, filePath);
        break;
      }
    }
  } catch (e) {
    console.error('Invalid terminal message:', e);
  }
}

export function createSessionWithWebSocket(
  ws: WSContext,
  worktreePath: string,
  repositoryId: string
): string {
  const session = sessionManager.createSession(
    worktreePath,
    repositoryId,
    (data) => {
      const msg: TerminalServerMessage = { type: 'output', data };
      ws.send(JSON.stringify(msg));
    },
    (exitCode, signal) => {
      const msg: TerminalServerMessage = { type: 'exit', exitCode, signal };
      ws.send(JSON.stringify(msg));
    }
  );

  return session.id;
}
