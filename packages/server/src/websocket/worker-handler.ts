import type { WSContext } from 'hono/ws';
import type { WorkerClientMessage } from '@agent-console/shared';
import { mkdir as defaultMkdir, unlink as defaultUnlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir as defaultTmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('worker-handler');

/**
 * SessionManager interface used by worker handler
 */
export interface WorkerHandlerSessionManager {
  writeWorkerInput: (sessionId: string, workerId: string, data: string) => void;
  resizeWorker: (sessionId: string, workerId: string, cols: number, rows: number) => void;
}

/**
 * Dependencies for worker handler (enables dependency injection for testing)
 */
export interface WorkerHandlerDependencies {
  sessionManager: WorkerHandlerSessionManager;
  mkdir: typeof defaultMkdir;
  unlink: typeof defaultUnlink;
  tmpdir: typeof defaultTmpdir;
  /** Delay in ms before auto-deleting uploaded images. Default: 5 minutes. */
  imageCleanupDelayMs: number;
}

/** Default cleanup delay: 5 minutes */
const DEFAULT_IMAGE_CLEANUP_DELAY_MS = 5 * 60 * 1000;

// Default dependencies (sessionManager must be provided explicitly)
const defaultDeps: Omit<WorkerHandlerDependencies, 'sessionManager'> = {
  mkdir: defaultMkdir,
  unlink: defaultUnlink,
  tmpdir: defaultTmpdir,
  imageCleanupDelayMs: DEFAULT_IMAGE_CLEANUP_DELAY_MS,
};

// Allowed MIME types and their extensions (security: only allow known image types)
const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
} as const;

// Maximum image size (10MB in base64 ≈ 13.3MB raw base64 string)
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

function isValidMimeType(mimeType: string): mimeType is keyof typeof ALLOWED_MIME_TYPES {
  return mimeType in ALLOWED_MIME_TYPES;
}

function getExtensionFromMimeType(mimeType: string): string | null {
  return ALLOWED_MIME_TYPES[mimeType] || null;
}

/**
 * Validate and type-check incoming WebSocket messages.
 * Returns null if the message is invalid.
 */
function validateWorkerMessage(parsed: unknown): WorkerClientMessage | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const msg = parsed as Record<string, unknown>;

  if (typeof msg.type !== 'string') {
    return null;
  }

  switch (msg.type) {
    case 'input':
      if (typeof msg.data !== 'string') {
        return null;
      }
      return { type: 'input', data: msg.data };

    case 'resize':
      if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') {
        return null;
      }
      // Validate reasonable terminal dimensions
      if (msg.cols < 1 || msg.cols > 1000 || msg.rows < 1 || msg.rows > 1000) {
        return null;
      }
      return { type: 'resize', cols: msg.cols, rows: msg.rows };

    case 'image':
      if (typeof msg.data !== 'string' || typeof msg.mimeType !== 'string') {
        return null;
      }
      return { type: 'image', data: msg.data, mimeType: msg.mimeType };

    case 'request-history':
      return { type: 'request-history' };

    default:
      return null;
  }
}

/**
 * Create a worker message handler with the given dependencies.
 * sessionManager is required - passed via dependency injection from AppContext.
 */
export function createWorkerMessageHandler(
  deps: Pick<WorkerHandlerDependencies, 'sessionManager'> & Partial<Omit<WorkerHandlerDependencies, 'sessionManager'>>
) {
  const { sessionManager, mkdir, unlink, tmpdir, imageCleanupDelayMs } = { ...defaultDeps, ...deps };

  // Directory for storing uploaded images
  const IMAGE_UPLOAD_DIR = join(tmpdir(), 'agent-console-images');

  // Ensure image upload directory exists (async init at factory level)
  const initPromise = mkdir(IMAGE_UPLOAD_DIR, { recursive: true }).catch((err) => {
    logger.warn({ err, dir: IMAGE_UPLOAD_DIR }, 'Failed to create image upload directory');
  });

  return async function handleWorkerMessage(
    _ws: WSContext,
    sessionId: string,
    workerId: string,
    message: string | ArrayBuffer
  ): Promise<void> {
    // Ensure directory is ready before processing image messages
    await initPromise;
    try {
      const msgStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const rawParsed: unknown = JSON.parse(msgStr);

      // SECURITY: Validate message structure before processing
      const parsed = validateWorkerMessage(rawParsed);
      if (!parsed) {
        logger.warn({ sessionId, workerId }, 'Invalid message structure');
        return;
      }

      switch (parsed.type) {
        case 'input':
          sessionManager.writeWorkerInput(sessionId, workerId, parsed.data);
          break;
        case 'resize':
          sessionManager.resizeWorker(sessionId, workerId, parsed.cols, parsed.rows);
          break;
        case 'image': {
          // SECURITY: Validate mimeType against allowlist
          if (!isValidMimeType(parsed.mimeType)) {
            logger.warn({ mimeType: parsed.mimeType, sessionId, workerId }, 'Invalid image MIME type');
            break;
          }

          // Base64 string length check (rough estimate: base64 is ~4/3 of original size)
          // Note: parsed.data is guaranteed to be a non-empty string by validateWorkerMessage
          const estimatedSize = Math.ceil(parsed.data.length * 3 / 4);
          if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
            logger.warn({ estimatedSize, maxSize: MAX_IMAGE_SIZE_BYTES, sessionId, workerId }, 'Image too large');
            break;
          }

          // Get extension (guaranteed to be non-null after isValidMimeType check)
          const ext = getExtensionFromMimeType(parsed.mimeType);
          if (!ext) {
            logger.warn({ mimeType: parsed.mimeType, sessionId, workerId }, 'Failed to get extension');
            break;
          }

          const filename = `${randomUUID()}.${ext}`;
          const filePath = join(IMAGE_UPLOAD_DIR, filename);

          // SECURITY: Validate base64 format before decoding
          // Buffer.from() tolerates invalid characters, so we need stricter validation
          const normalizedData = parsed.data.replace(/\s+/g, '');
          if (!/^[0-9A-Za-z+/]+={0,2}$/.test(normalizedData)) {
            logger.warn({ sessionId, workerId }, 'Invalid base64 characters in image data');
            break;
          }

          // Decode base64 and validate actual size
          let buffer: Buffer;
          try {
            buffer = Buffer.from(normalizedData, 'base64');
          } catch {
            logger.warn({ sessionId, workerId }, 'Invalid base64 data');
            break;
          }

          if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
            logger.warn({ actualSize: buffer.length, maxSize: MAX_IMAGE_SIZE_BYTES, sessionId, workerId }, 'Decoded image too large');
            break;
          }

          await Bun.write(filePath, buffer);

          logger.debug({ filePath, size: buffer.length }, 'Image saved');

          // Schedule cleanup to prevent unbounded disk growth.
          // The agent should read the file well within the timeout window.
          setTimeout(() => {
            unlink(filePath).catch((err) => {
              // ENOENT is expected if the file was already deleted (e.g., manual cleanup)
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.warn({ err, filePath }, 'Failed to clean up uploaded image');
              }
            });
          }, imageCleanupDelayMs);

          // Send file path to PTY stdin (Claude Code will read the image)
          sessionManager.writeWorkerInput(sessionId, workerId, filePath);
          break;
        }

        case 'request-history':
          // request-history is handled separately in routes.ts before this handler is called.
          // If it reaches here, it means validation allowed it but routing didn't intercept it.
          // This should not happen in normal operation.
          logger.warn({ sessionId, workerId }, 'request-history message reached worker handler (should be handled by routes.ts)');
          break;

        default: {
          // Exhaustive check: TypeScript will error if a new message type is added but not handled
          const _exhaustive: never = parsed;
          logger.warn({ messageType: (_exhaustive as WorkerClientMessage).type, sessionId, workerId }, 'Unknown worker message type');
        }
      }
    } catch (e) {
      logger.warn({ err: e, sessionId, workerId }, 'Invalid worker message');
    }
  };
}
