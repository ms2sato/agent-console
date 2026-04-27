/**
 * Routes interactive-process content (stdout chunks and response echoes) to
 * either the worker PTY (full content) or to inter-session message files
 * (chunked) with a brief PTY notification, based on the process's
 * `outputMode`.
 *
 * The router is decoupled from `app-context` wiring so it can be tested in
 * isolation without booting the full service graph.
 */

import type { InteractiveProcessInfo } from '@agent-console/shared';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import { writePtyNotification } from '../lib/pty-notification.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('process-output-router');

/**
 * Maximum bytes per message-file chunk. Slightly under the
 * `MAX_MESSAGE_CONTENT_BYTES` (64 KB) limit enforced by
 * {@link InterSessionMessageService.sendMessage} to leave headroom for any
 * envelope overhead.
 */
export const MESSAGE_CHUNK_TARGET_BYTES = 60 * 1024;

/** Direction of the routed content (used for logging and notification text). */
export type ProcessOutputDirection = 'stdout' | 'response';

export interface ProcessOutputRouterDeps {
  /**
   * Resolve the session-data path resolver for a given session id, or
   * `null` when the session has no resolvable scope (e.g., already deleted).
   */
  getResolver: (sessionId: string) => SessionDataPathResolver | null;
  /** Write data to the calling worker's PTY (used for the notification). */
  writeInput: (sessionId: string, workerId: string, data: string) => void;
  /** Send a message file via the inter-session message service. */
  sendMessage: (params: {
    toSessionId: string;
    toWorkerId: string;
    fromSessionId: string;
    content: string;
    resolver: SessionDataPathResolver;
  }) => Promise<{ messageId: string; path: string }>;
}

export interface RouteProcessContentParams {
  process: InteractiveProcessInfo;
  content: string;
  direction: ProcessOutputDirection;
}

/**
 * Split a string into chunks no larger than `targetBytes` UTF-8 bytes,
 * preferring to break on a line boundary (`\n`) within the chunk. The last
 * chunk may be shorter than the target. Empty input yields an empty array.
 *
 * Exported for unit testing.
 *
 * @internal Exported for testing
 */
export function splitContentIntoChunks(content: string, targetBytes: number): string[] {
  if (content.length === 0) {
    return [];
  }
  if (Buffer.byteLength(content, 'utf-8') <= targetBytes) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, 'utf-8') <= targetBytes) {
      chunks.push(remaining);
      break;
    }

    // Find the largest prefix whose UTF-8 byte length fits in targetBytes.
    let cutChar = remaining.length;
    let cutBytes = Buffer.byteLength(remaining.slice(0, cutChar), 'utf-8');
    while (cutBytes > targetBytes) {
      cutChar = Math.floor(cutChar * (targetBytes / cutBytes));
      if (cutChar < 1) cutChar = 1;
      cutBytes = Buffer.byteLength(remaining.slice(0, cutChar), 'utf-8');
      // Tighten if the heuristic over-shrank.
      while (
        cutChar < remaining.length &&
        Buffer.byteLength(remaining.slice(0, cutChar + 1), 'utf-8') <= targetBytes
      ) {
        cutChar += 1;
      }
    }

    // Prefer cutting at the last newline within the candidate prefix, when
    // such a newline exists. This keeps log lines whole across chunks.
    const candidate = remaining.slice(0, cutChar);
    const newlineIdx = candidate.lastIndexOf('\n');
    let cut: number;
    if (newlineIdx > 0) {
      cut = newlineIdx + 1;
    } else {
      cut = cutChar;
    }

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

/**
 * Route process content according to the process's outputMode.
 *
 * - `'pty'` — emit a single `[internal:process]` notification carrying the
 *   full content (existing behavior).
 * - `'message'` — split content into <= MESSAGE_CHUNK_TARGET_BYTES chunks,
 *   write each chunk via `sendMessage`, and emit a brief PTY notification
 *   carrying the file path and byte count for each chunk.
 *
 * The function is async because message writes are async; callers may
 * await the returned promise or fire-and-track via `.catch` (the function
 * never rejects — it logs failures and returns).
 */
export async function routeProcessContent(
  deps: ProcessOutputRouterDeps,
  params: RouteProcessContentParams,
): Promise<void> {
  const { process, content, direction } = params;
  if (content.length === 0) {
    return;
  }

  const writeInputForWorker = (data: string) =>
    deps.writeInput(process.sessionId, process.workerId, data);

  if (process.outputMode === 'pty') {
    try {
      writePtyNotification({
        kind: 'internal-process',
        tag: 'internal:process',
        fields: {
          processId: process.id,
          command: process.command,
          message: content,
        },
        intent: direction === 'stdout' ? 'triage' : 'inform',
        writeInput: writeInputForWorker,
      });
    } catch (err) {
      logger.warn(
        { processId: process.id, sessionId: process.sessionId, direction, err },
        'Failed to deliver process PTY notification',
      );
    }
    return;
  }

  // outputMode === 'message'
  const resolver = deps.getResolver(process.sessionId);
  if (!resolver) {
    logger.warn(
      { processId: process.id, sessionId: process.sessionId, direction },
      'Cannot resolve data path for message-mode process; skipping message routing',
    );
    return;
  }

  const chunks = splitContentIntoChunks(content, MESSAGE_CHUNK_TARGET_BYTES);
  for (const chunk of chunks) {
    let result: { path: string };
    try {
      result = await deps.sendMessage({
        toSessionId: process.sessionId,
        toWorkerId: process.workerId,
        fromSessionId: process.sessionId,
        content: chunk,
        resolver,
      });
    } catch (err) {
      logger.warn(
        { processId: process.id, sessionId: process.sessionId, direction, err },
        'Failed to write process content to message file',
      );
      continue;
    }

    const bytes = Buffer.byteLength(chunk, 'utf-8');
    const summary =
      direction === 'stdout'
        ? `[stdout via message] path=${result.path} bytes=${bytes}`
        : `[response via message] path=${result.path} bytes=${bytes}`;

    try {
      writePtyNotification({
        kind: 'internal-process',
        tag: 'internal:process',
        fields: {
          processId: process.id,
          command: process.command,
          message: summary,
        },
        intent: direction === 'stdout' ? 'triage' : 'inform',
        writeInput: writeInputForWorker,
      });
    } catch (err) {
      logger.warn(
        { processId: process.id, sessionId: process.sessionId, direction, err },
        'Failed to deliver brief process PTY notification (message file was written)',
      );
    }
  }
}
