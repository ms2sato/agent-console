import type { WSContext } from 'hono/ws';
import type { FileViewerServerMessage, WorkerServerMessage } from '@agent-console/shared';
import type { subscribeToFileChanges } from '../services/file-watch-service.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('file-viewer-handler');

/** Trailing debounce of the viewer's change batches (ms). */
const VIEWER_DEBOUNCE_MS = 300;
/** Cap from a window's first event to its delivery (ms), so a steady stream still shows up. */
const VIEWER_MAX_WAIT_MS = 2000;
/** Distinct paths per batch; a further one turns the batch into an overflow. */
const VIEWER_MAX_PATHS = 200;

/** Segments the viewer never reports. Exact whole-segment matches, not the diff worker's list. */
const VIEWER_IGNORED_SEGMENTS: readonly string[] = ['.git', 'node_modules'];

/**
 * The viewer lists everything, so its watcher ignores only the two trees that
 * churn without the user caring: `.git` and `node_modules`, matched as whole
 * segments (`.github/x`, `.gitignore` and `foo.git/x` still report).
 */
export function viewerIgnores(relPath: string): boolean {
  return relPath.split('/').some((segment) => VIEWER_IGNORED_SEGMENTS.includes(segment));
}

export interface FileViewerHandlerDependencies {
  subscribe: typeof subscribeToFileChanges;
}

export function createFileViewerHandlers(deps: FileViewerHandlerDependencies) {
  const { subscribe } = deps;

  // The open viewer connections, keyed by socket (several tabs can hold one worker, each with its own
  // watch subscription). The same WSContext object reaches onOpen and onClose.
  const activeConnections = new Map<WSContext, { workerId: string; unsubscribe: () => void }>();

  function send(ws: WSContext, message: FileViewerServerMessage | WorkerServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      // The socket may already be closing; the disconnection cleanup unsubscribes.
      log.debug({ error }, 'Failed to send a file viewer frame');
    }
  }

  /**
   * Subscribe the connection to changes under the session's working
   * directory. A watch that cannot be opened is reported once with
   * `watch-unavailable`; the connection then stays open and silent (the viewer
   * keeps working through its Refresh button).
   */
  function handleConnection(ws: WSContext, sessionId: string, workerId: string, locationPath: string): void {
    log.info({ sessionId, workerId, locationPath }, 'File viewer WebSocket connected');

    const unsubscribe = subscribe(locationPath, {
      ignore: viewerIgnores,
      debounceMs: VIEWER_DEBOUNCE_MS,
      maxWaitMs: VIEWER_MAX_WAIT_MS,
      maxPaths: VIEWER_MAX_PATHS,
      onChange: (batch) => {
        send(ws, { type: 'files-changed', paths: batch.paths, overflow: batch.overflow });
      },
      onError: (reason) => {
        send(ws, { type: 'watch-unavailable', reason });
      },
    });
    activeConnections.set(ws, { workerId, unsubscribe });
  }

  /**
   * Stop watch subscriptions. With `ws` (a socket's own close) only that socket's subscription is stopped,
   * and a socket that is not registered (already removed) is a no-op, so a late close never touches another
   * connection. Without `ws` (a service tearing the worker down: pause, delete) every connection of the
   * worker is stopped. Idempotent.
   */
  function handleDisconnection(sessionId: string, workerId: string, ws?: WSContext): void {
    if (ws !== undefined) {
      const connection = activeConnections.get(ws);
      if (!connection) return;
      log.info({ sessionId, workerId }, 'File viewer WebSocket disconnected');
      activeConnections.delete(ws);
      connection.unsubscribe();
      return;
    }
    for (const [socket, connection] of [...activeConnections]) {
      if (connection.workerId !== workerId) continue;
      log.info({ sessionId, workerId }, 'File viewer WebSocket disconnected');
      activeConnections.delete(socket);
      connection.unsubscribe();
    }
  }

  /** The viewer's socket is server-to-client only: answer a client frame with an error and keep the socket open. */
  function handleMessage(ws: WSContext): void {
    send(ws, { type: 'error', message: 'The file viewer accepts no client messages', code: 'UNSUPPORTED_OPERATION' });
  }

  return { handleConnection, handleDisconnection, handleMessage };
}

// ============================================================
// Late-bound Exports (initialized via initializeFileViewerHandlers)
// ============================================================

let _handlers: ReturnType<typeof createFileViewerHandlers> | null = null;

/**
 * Initialize the default file-viewer handlers with injected dependencies.
 * Must be called once at startup before any WebSocket connections are accepted.
 */
export function initializeFileViewerHandlers(deps: FileViewerHandlerDependencies): void {
  _handlers = createFileViewerHandlers(deps);
}

function getHandlers(): ReturnType<typeof createFileViewerHandlers> {
  if (!_handlers) {
    throw new Error('File viewer handlers not initialized. Call initializeFileViewerHandlers() first.');
  }
  return _handlers;
}

export function handleFileViewerConnection(
  ...args: Parameters<ReturnType<typeof createFileViewerHandlers>['handleConnection']>
): void {
  return getHandlers().handleConnection(...args);
}

export function handleFileViewerDisconnection(
  ...args: Parameters<ReturnType<typeof createFileViewerHandlers>['handleDisconnection']>
): void {
  return getHandlers().handleDisconnection(...args);
}

export function handleFileViewerMessage(
  ...args: Parameters<ReturnType<typeof createFileViewerHandlers>['handleMessage']>
): void {
  return getHandlers().handleMessage(...args);
}
