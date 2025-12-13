import type { WSContext } from 'hono/ws';
import type { GitDiffClientMessage, GitDiffServerMessage, GitDiffData } from '@agent-console/shared';
import {
  getDiffData as getDiffDataImpl,
  resolveRef as resolveRefImpl,
  startWatching as startWatchingImpl,
  stopWatching as stopWatchingImpl,
} from '../services/git-diff-service.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('git-diff-handler');

// ============================================================
// Types for Dependency Injection
// ============================================================

export interface GitDiffHandlerDependencies {
  getDiffData: (repoPath: string, baseCommit: string) => Promise<GitDiffData>;
  resolveRef: (ref: string, repoPath: string) => Promise<string | null>;
  startWatching: (repoPath: string, onChange: () => void) => void;
  stopWatching: (repoPath: string) => void;
}

// Default dependencies using real implementations
const defaultDependencies: GitDiffHandlerDependencies = {
  getDiffData: getDiffDataImpl,
  resolveRef: resolveRefImpl,
  startWatching: startWatchingImpl,
  stopWatching: stopWatchingImpl,
};

// ============================================================
// Connection State Management
// ============================================================

interface ConnectionState {
  ws: WSContext;
  locationPath: string;
  baseCommit: string;
}

// Track active connections by workerId
const activeConnections = new Map<string, ConnectionState>();

// ============================================================
// Factory Function for Dependency Injection (Testing)
// ============================================================

export function createGitDiffHandlers(deps: GitDiffHandlerDependencies = defaultDependencies) {
  const { getDiffData, resolveRef, startWatching, stopWatching } = deps;

  /**
   * Send diff data to the client.
   */
  async function sendDiffData(
    ws: WSContext,
    locationPath: string,
    baseCommit: string
  ): Promise<void> {
    try {
      const diffData = await getDiffData(locationPath, baseCommit);
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

    // Store connection state
    const connectionKey = workerId;
    activeConnections.set(connectionKey, { ws, locationPath, baseCommit });

    // Start file watching - when files change, send updated diff data
    startWatching(locationPath, () => {
      const state = activeConnections.get(connectionKey);
      if (state) {
        log.debug({ locationPath }, 'File change detected, sending updated diff');
        sendDiffData(state.ws, state.locationPath, state.baseCommit).catch((err) => {
          log.error({ err }, 'Failed to send diff data on file change');
        });
      }
    });

    // Send initial diff data
    await sendDiffData(ws, locationPath, baseCommit);
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
   * Handle git-diff client messages (refresh, set-base-commit).
   */
  async function handleMessage(
    ws: WSContext,
    _sessionId: string,
    workerId: string,
    locationPath: string,
    currentBaseCommit: string,
    message: string
  ): Promise<void> {
    try {
      const parsed: GitDiffClientMessage = JSON.parse(message);

      switch (parsed.type) {
        case 'refresh':
          await sendDiffData(ws, locationPath, currentBaseCommit);
          break;

        case 'set-base-commit': {
          // Resolve the ref to a commit hash
          const resolved = await resolveRef(parsed.ref, locationPath);
          if (resolved) {
            // Update stored baseCommit
            const connectionKey = workerId;
            const state = activeConnections.get(connectionKey);
            if (state) {
              state.baseCommit = resolved;
            }
            await sendDiffData(ws, locationPath, resolved);
          } else {
            sendError(ws, `Invalid ref: ${parsed.ref}`);
          }
          break;
        }
      }
    } catch (e) {
      log.error({ err: e }, 'Invalid git-diff message');
      sendError(ws, 'Invalid message format');
    }
  }

  return {
    handleConnection,
    handleDisconnection,
    handleMessage,
  };
}

// ============================================================
// Default Exports (for production use)
// ============================================================

const defaultHandlers = createGitDiffHandlers();

export const handleGitDiffConnection = defaultHandlers.handleConnection;
export const handleGitDiffDisconnection = defaultHandlers.handleDisconnection;
export const handleGitDiffMessage = defaultHandlers.handleMessage;
