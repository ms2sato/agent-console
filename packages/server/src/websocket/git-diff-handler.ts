import type { WSContext } from 'hono/ws';
import type { GitDiffClientMessage, GitDiffServerMessage } from '@agent-console/shared';
import { getDiffData, resolveRef } from '../services/git-diff-service.js';

/**
 * Handle git-diff WebSocket connection.
 * Sets up the connection and sends initial diff data.
 */
export async function handleGitDiffConnection(
  ws: WSContext,
  sessionId: string,
  workerId: string,
  locationPath: string,
  baseCommit: string
): Promise<void> {
  console.log(`Git Diff WebSocket connected: session=${sessionId}, worker=${workerId}`);

  // Send initial diff data
  await sendDiffData(ws, locationPath, baseCommit);
}

/**
 * Handle git-diff client messages (refresh, set-base-commit).
 */
export async function handleGitDiffMessage(
  ws: WSContext,
  _sessionId: string,
  _workerId: string,
  locationPath: string,
  currentBaseCommit: string,
  message: string,
  updateBaseCommit: (newBaseCommit: string) => void
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
          updateBaseCommit(resolved);
          await sendDiffData(ws, locationPath, resolved);
        } else {
          sendError(ws, `Invalid ref: ${parsed.ref}`);
        }
        break;
      }
    }
  } catch (e) {
    console.error('Invalid git-diff message:', e);
    sendError(ws, 'Invalid message format');
  }
}

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
