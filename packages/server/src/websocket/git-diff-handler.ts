import type { WSContext } from 'hono/ws';
import { MERGE_BASE_REF_PREFIX } from '@agent-console/shared';
import type { GitDiffClientMessage, GitDiffServerMessage, GitDiffData, GitDiffTarget, ReviewAnnotationSet } from '@agent-console/shared';
import type { AnnotationService } from '../services/annotation-service.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('git-diff-handler');

// ============================================================
// Types for Dependency Injection
// ============================================================

export interface GitDiffHandlerDependencies {
  getDiffData: (repoPath: string, baseCommit: string, targetRef?: GitDiffTarget) => Promise<GitDiffData>;
  resolveRef: (ref: string, repoPath: string) => Promise<string | null>;
  getMergeBase: (ref1: string, ref2: string, repoPath: string) => Promise<string | null>;
  startWatching: (repoPath: string, onChange: () => void) => void;
  stopWatching: (repoPath: string) => void;
  getFileLines: (repoPath: string, filePath: string, startLine: number, endLine: number, ref: GitDiffTarget) => Promise<string[]>;
  annotationService: AnnotationService;
}

// ============================================================
// Connection State Management
// ============================================================

interface ConnectionState {
  ws: WSContext;
  locationPath: string;
  baseCommit: string;
  targetRef: GitDiffTarget;
}

// Track active connections by workerId
const activeConnections = new Map<string, ConnectionState>();

// ============================================================
// Factory Function for Dependency Injection (Testing)
// ============================================================

export function createGitDiffHandlers(deps: GitDiffHandlerDependencies) {
  const { getDiffData, resolveRef, getMergeBase, startWatching, stopWatching, getFileLines, annotationService } = deps;

  /**
   * Send diff data to the client.
   */
  async function sendDiffData(
    ws: WSContext,
    locationPath: string,
    baseCommit: string,
    targetRef: GitDiffTarget = 'working-dir'
  ): Promise<void> {
    try {
      const diffData = await getDiffData(locationPath, baseCommit, targetRef);
      const msg: GitDiffServerMessage = {
        type: 'diff-data',
        data: diffData,
      };
      ws.send(JSON.stringify(msg));
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Failed to get diff data';
      sendError(ws, error);
    }
  }

  /**
   * Send error message to the client.
   */
  function sendError(ws: WSContext, error: string): void {
    const msg: GitDiffServerMessage = {
      type: 'diff-error',
      error,
    };
    ws.send(JSON.stringify(msg));
  }

  /**
   * Handle git-diff WebSocket connection.
   * Starts file watching and sends initial diff data.
   */
  async function handleConnection(
    ws: WSContext,
    sessionId: string,
    workerId: string,
    locationPath: string,
    baseCommit: string
  ): Promise<void> {
    log.info({ sessionId, workerId, locationPath }, 'Git diff WebSocket connected');

    // Store connection state (default target is working-dir)
    const connectionKey = workerId;
    const targetRef: GitDiffTarget = 'working-dir';
    activeConnections.set(connectionKey, { ws, locationPath, baseCommit, targetRef });

    // Start file watching - when files change, send updated diff data
    // Note: File watching only makes sense for working-dir target
    startWatching(locationPath, () => {
      const state = activeConnections.get(connectionKey);
      if (state && state.targetRef === 'working-dir') {
        log.debug({ locationPath }, 'File change detected, sending updated diff');
        sendDiffData(state.ws, state.locationPath, state.baseCommit, state.targetRef).catch((err) => {
          log.error({ err }, 'Failed to send diff data on file change');
        });
      }
    });

    // Send initial diff data
    await sendDiffData(ws, locationPath, baseCommit, targetRef);
  }

  /**
   * Handle git-diff WebSocket disconnection.
   * Stops file watching.
   */
  async function handleDisconnection(
    sessionId: string,
    workerId: string
  ): Promise<void> {
    log.info({ sessionId, workerId }, 'Git diff WebSocket disconnected');

    const connectionKey = workerId;
    const state = activeConnections.get(connectionKey);

    if (state) {
      // Stop file watching
      stopWatching(state.locationPath);
      activeConnections.delete(connectionKey);
    }
  }

  /**
   * Handle git-diff client messages (refresh, set-base-commit, set-target-commit).
   */
  async function handleMessage(
    ws: WSContext,
    _sessionId: string,
    workerId: string,
    locationPath: string,
    message: string
  ): Promise<void> {
    try {
      const parsed: GitDiffClientMessage = JSON.parse(message);
      const connectionKey = workerId;
      const state = activeConnections.get(connectionKey);
      if (!state) {
        sendError(ws, 'No active connection for this worker');
        return;
      }
      const currentTargetRef = state.targetRef;

      switch (parsed.type) {
        case 'refresh':
          await sendDiffData(ws, locationPath, state.baseCommit, currentTargetRef);
          break;

        case 'set-base-commit': {
          let resolved: string | null;

          if (parsed.ref.startsWith(MERGE_BASE_REF_PREFIX)) {
            // Resolve via git merge-base <branch> HEAD
            const branchName = parsed.ref.slice(MERGE_BASE_REF_PREFIX.length);
            resolved = await getMergeBase(branchName, 'HEAD', locationPath);
            if (resolved) {
              state.baseCommit = resolved;
              await sendDiffData(ws, locationPath, resolved, currentTargetRef);
            } else {
              sendError(ws, `Could not find fork point from '${branchName}'`);
            }
          } else {
            // Resolve via git rev-parse
            resolved = await resolveRef(parsed.ref, locationPath);
            if (resolved) {
              state.baseCommit = resolved;
              await sendDiffData(ws, locationPath, resolved, currentTargetRef);
            } else {
              sendError(ws, `Invalid ref: ${parsed.ref}`);
            }
          }
          break;
        }

        case 'set-target-commit': {
          // Handle 'working-dir' or resolve ref to commit hash
          let targetRef: GitDiffTarget;
          if (parsed.ref === 'working-dir') {
            targetRef = 'working-dir';
          } else {
            const resolved = await resolveRef(parsed.ref, locationPath);
            if (resolved) {
              targetRef = resolved;
            } else {
              sendError(ws, `Invalid target ref: ${parsed.ref}`);
              return;
            }
          }

          state.targetRef = targetRef;
          await sendDiffData(ws, locationPath, state.baseCommit, targetRef);
          break;
        }

        case 'get-file-lines': {
          try {
            const lines = await getFileLines(locationPath, parsed.path, parsed.startLine, parsed.endLine, parsed.ref);
            const msg: GitDiffServerMessage = {
              type: 'file-lines',
              path: parsed.path,
              startLine: parsed.startLine,
              lines,
            };
            ws.send(JSON.stringify(msg));
          } catch (e) {
            const error = e instanceof Error ? e.message : 'Failed to get file lines';
            sendError(ws, error);
          }
          break;
        }

        case 'get-annotations': {
          const annotations = annotationService.getAnnotations(workerId);
          const msg: GitDiffServerMessage = {
            type: 'annotations-updated',
            annotations,
          };
          ws.send(JSON.stringify(msg));
          break;
        }

        default: {
          // Exhaustive check: TypeScript will error if a new message type is added but not handled
          const _exhaustive: never = parsed;
          log.error({ messageType: (_exhaustive as GitDiffClientMessage).type }, 'Unknown git-diff message type');
          sendError(ws, 'Unknown message type');
        }
      }
    } catch (e) {
      log.error({ err: e }, 'Invalid git-diff message');
      sendError(ws, 'Invalid message format');
    }
  }

  /**
   * Update the base commit for an active connection and send fresh diff data.
   * If no active connection exists for the workerId, silently returns.
   */
  async function updateBaseCommit(workerId: string, newBaseCommit: string): Promise<void> {
    const state = activeConnections.get(workerId);
    if (!state) {
      return;
    }

    state.baseCommit = newBaseCommit;
    await sendDiffData(state.ws, state.locationPath, newBaseCommit, state.targetRef);
  }

  /**
   * Send annotations to the client connected for a given workerId.
   * Silently returns if no active connection exists.
   */
  function sendAnnotationsToClient(workerId: string, annotations: ReviewAnnotationSet | null): void {
    const state = activeConnections.get(workerId);
    if (!state) {
      return;
    }

    const msg: GitDiffServerMessage = {
      type: 'annotations-updated',
      annotations,
    };
    state.ws.send(JSON.stringify(msg));
  }

  return {
    handleConnection,
    handleDisconnection,
    handleMessage,
    updateBaseCommit,
    sendAnnotationsToClient,
  };
}

// ============================================================
// Late-bound Exports (initialized via initializeGitDiffHandlers)
// ============================================================

let _handlers: ReturnType<typeof createGitDiffHandlers> | null = null;

/**
 * Initialize the default git-diff handlers with injected dependencies.
 * Must be called once at startup before any WebSocket connections are accepted.
 */
export function initializeGitDiffHandlers(deps: GitDiffHandlerDependencies): void {
  _handlers = createGitDiffHandlers(deps);
}

function getHandlers(): ReturnType<typeof createGitDiffHandlers> {
  if (!_handlers) {
    throw new Error('Git diff handlers not initialized. Call initializeGitDiffHandlers() first.');
  }
  return _handlers;
}

export function handleGitDiffConnection(
  ...args: Parameters<ReturnType<typeof createGitDiffHandlers>['handleConnection']>
): Promise<void> {
  return getHandlers().handleConnection(...args);
}

export function handleGitDiffDisconnection(
  ...args: Parameters<ReturnType<typeof createGitDiffHandlers>['handleDisconnection']>
): Promise<void> {
  return getHandlers().handleDisconnection(...args);
}

export function handleGitDiffMessage(
  ...args: Parameters<ReturnType<typeof createGitDiffHandlers>['handleMessage']>
): Promise<void> {
  return getHandlers().handleMessage(...args);
}

export function updateGitDiffBaseCommit(
  ...args: Parameters<ReturnType<typeof createGitDiffHandlers>['updateBaseCommit']>
): Promise<void> {
  return getHandlers().updateBaseCommit(...args);
}

export function sendAnnotationsToClient(
  ...args: Parameters<ReturnType<typeof createGitDiffHandlers>['sendAnnotationsToClient']>
): void {
  return getHandlers().sendAnnotationsToClient(...args);
}
