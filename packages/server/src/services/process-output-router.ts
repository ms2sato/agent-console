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
import type { PtyNotificationParams } from '../lib/pty-notification.js';
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
  /**
   * Deliver a notification to the calling worker via the shared delivery
   * seam ({@link SessionManager.deliverWorkerNotification}) -- a PTY write
   * for agent/terminal workers, or a queued turn for embedded-agent
   * workers.
   */
  deliverNotification: (
    sessionId: string,
    workerId: string,
    params: PtyNotificationParams,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
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
 * preferring to break on a line boundary (`\n`) within the chunk and never
 * splitting a UTF-16 surrogate pair. The last chunk may be shorter than the
 * target. Empty input yields an empty array.
 *
 * Throws `RangeError` when `targetBytes` is not a positive integer — this
 * is a defensive check to avoid the chunking loop failing to make progress.
 *
 * Exported for unit testing.
 *
 * @internal Exported for testing
 */
export function splitContentIntoChunks(content: string, targetBytes: number): string[] {
  if (!Number.isInteger(targetBytes) || targetBytes <= 0) {
    throw new RangeError(
      `targetBytes must be a positive integer, got ${targetBytes}`,
    );
  }
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

    // Don't split a UTF-16 surrogate pair across chunks. Slicing between a
    // high (0xD800-0xDBFF) and low (0xDC00-0xDFFF) surrogate would corrupt
    // the represented code point (emoji, non-BMP CJK, etc.).
    if (
      cut > 0 &&
      cut < remaining.length &&
      remaining.charCodeAt(cut - 1) >= 0xd800 &&
      remaining.charCodeAt(cut - 1) <= 0xdbff &&
      remaining.charCodeAt(cut) >= 0xdc00 &&
      remaining.charCodeAt(cut) <= 0xdfff
    ) {
      cut -= 1;
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
 *   full content (existing behavior). Delivery failures reported by
 *   `deliverNotification` (`{ok: false}`) are logged as warnings and
 *   swallowed because they are cosmetic (the calling code has nowhere to
 *   report a failed notification to).
 * - `'message'` — split content into <= `MESSAGE_CHUNK_TARGET_BYTES`
 *   chunks, write each chunk via `sendMessage`, and emit a brief
 *   notification carrying the file path and byte count for each chunk.
 *   **Routing failures (resolver miss or any chunk's `sendMessage` error)
 *   throw**, so callers awaiting the returned promise can detect that
 *   message-mode delivery did not happen and report a `false` success
 *   to their own caller. Brief notification delivery failures after a
 *   successful chunk write are still cosmetic — they are logged as warnings
 *   and do not throw.
 */
export async function routeProcessContent(
  deps: ProcessOutputRouterDeps,
  params: RouteProcessContentParams,
): Promise<void> {
  const { process, content, direction } = params;
  if (content.length === 0) {
    return;
  }

  if (process.outputMode === 'pty') {
    const result = await deps.deliverNotification(process.sessionId, process.workerId, {
      kind: 'internal-process',
      tag: 'internal:process',
      fields: {
        processId: process.id,
        command: process.command,
        message: content,
      },
      intent: direction === 'stdout' ? 'triage' : 'inform',
    });
    if (!result.ok) {
      logger.warn(
        { processId: process.id, sessionId: process.sessionId, direction, error: result.error },
        'Failed to deliver process PTY notification',
      );
    }
    return;
  }

  // outputMode === 'message'
  const resolver = deps.getResolver(process.sessionId);
  if (!resolver) {
    throw new Error(
      `Cannot resolve data path for message-mode process ${process.id} (session ${process.sessionId})`,
    );
  }

  const chunks = splitContentIntoChunks(content, MESSAGE_CHUNK_TARGET_BYTES);
  for (const chunk of chunks) {
    const sendResult = await deps.sendMessage({
      toSessionId: process.sessionId,
      toWorkerId: process.workerId,
      fromSessionId: process.sessionId,
      content: chunk,
      resolver,
    });

    const bytes = Buffer.byteLength(chunk, 'utf-8');
    const summary =
      direction === 'stdout'
        ? `[stdout via message] path=${sendResult.path} bytes=${bytes}`
        : `[response via message] path=${sendResult.path} bytes=${bytes}`;

    const notifyResult = await deps.deliverNotification(process.sessionId, process.workerId, {
      kind: 'internal-process',
      tag: 'internal:process',
      fields: {
        processId: process.id,
        command: process.command,
        message: summary,
      },
      intent: direction === 'stdout' ? 'triage' : 'inform',
    });
    if (!notifyResult.ok) {
      logger.warn(
        { processId: process.id, sessionId: process.sessionId, direction, error: notifyResult.error },
        'Failed to deliver brief process PTY notification (message file was written)',
      );
    }
  }
}
