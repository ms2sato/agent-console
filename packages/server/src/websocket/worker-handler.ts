import type { WSContext } from 'hono/ws';
import type { WorkerClientMessage } from '@agent-console/shared';
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
  deps: WorkerHandlerDependencies
) {
  const { sessionManager } = deps;

  return async function handleWorkerMessage(
    _ws: WSContext,
    sessionId: string,
    workerId: string,
    message: string | ArrayBuffer
  ): Promise<void> {
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
