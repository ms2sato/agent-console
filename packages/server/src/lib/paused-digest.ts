/**
 * Pure composition of the notifications deferred while a session was paused.
 *
 * On resume each worker receives ONE `internal-paused-digest` notification
 * (composed by {@link composePausedDigest}) and the full list is written to a
 * read-more file (composed by {@link composeDeferredReadMore}). Nothing here
 * touches the filesystem, the database or the clock; the flush in
 * `SessionManager` feeds it parsed rows and delivers what it returns.
 *
 * See docs/design/session-pause-resume.md.
 */
import type { PtyNotificationKind } from '@agent-console/shared';
import {
  buildPtyNotificationText,
  type InternalPausedDigestPtyNotification,
  type PtyNotificationParams,
} from './pty-notification.js';

/** One deferred notification, with `params` already parsed from `params_json`. */
export interface PausedDigestEntry {
  id: string;
  workerId: string;
  kind: PtyNotificationKind;
  params: PtyNotificationParams;
  sourceId: string | null;
  /** Sender session of an inter-session message; NULL when the sender was deleted. */
  replyToSessionId: string | null;
  /** ISO 8601 UTC time the notification arrived (the row's `created_at`). */
  createdAt: string;
}

export interface PausedDigestOptions {
  pausedAt: string;
  resumedAt: string;
  /** Absolute path of the read-more file; named in every digest header and in the omitted line. */
  path: string;
  /** At most this many entries are shown; the oldest beyond it are dropped. */
  maxEntries: number;
  /** At most this many characters of body; the oldest entries are dropped until it fits. */
  maxChars: number;
}

/** The digest as notification params (no `writeInput`): the seam delivers it like any other kind. */
export type PausedDigestParams = Omit<InternalPausedDigestPtyNotification, 'writeInput'> & { body: string };

const FRAMING =
  'These notifications arrived while this session was paused. They are listed oldest first, each with the time it originally arrived. ' +
  'Some may need action, some may be stale by now, and some may need confirming with the sender before you act on them. ' +
  'Timers and wakeups were suspended while paused and resume after this digest.';

function oldestFirst(entries: readonly PausedDigestEntry[]): PausedDigestEntry[] {
  return [...entries].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * One line for an entry: its own `[tag] k=v` rendering stamped with the
 * ORIGINAL arrival time (not the digest's), plus a reply hint for an
 * inter-session message whose sender still exists. A `body` the stored params
 * carry (a digest deferred by a second pause) is dropped: its `path` field
 * already points at the file that holds it.
 */
function renderEntry(entry: PausedDigestEntry): string {
  const { body: _body, ...params } = entry.params;
  const line = buildPtyNotificationText({ ...params, timestamp: entry.createdAt }).trimStart();
  if (entry.kind === 'internal-message' && entry.replyToSessionId !== null) {
    return `${line} | reply: send_session_message toSessionId=${JSON.stringify(entry.replyToSessionId)}`;
  }
  return line;
}

function buildBody(shown: readonly PausedDigestEntry[], omitted: number, path: string): string {
  const lines: string[] = [];
  if (omitted > 0) lines.push(`${omitted} older entries omitted, full list at ${path}`);
  lines.push(FRAMING);
  for (const entry of shown) lines.push(renderEntry(entry));
  return lines.join('\n');
}

/**
 * Compose the digest for one worker, or `null` when there is nothing to report.
 * Entries are shown oldest first. When more than `maxEntries` arrived, or the
 * body would exceed `maxChars`, the OLDEST entries are dropped (the newest are
 * what the worker most needs) and the header's `omitted` and the body's first
 * line say how many; the read-more file at `path` has them all. The budget is
 * strict: if even the newest entry does not fit, none is shown.
 */
export function composePausedDigest(
  entries: readonly PausedDigestEntry[],
  options: PausedDigestOptions,
): PausedDigestParams | null {
  if (entries.length === 0) return null;

  const ordered = oldestFirst(entries);
  let omitted = Math.max(0, ordered.length - options.maxEntries);
  let body = buildBody(ordered.slice(omitted), omitted, options.path);
  while (body.length > options.maxChars && omitted < ordered.length) {
    omitted += 1;
    body = buildBody(ordered.slice(omitted), omitted, options.path);
  }

  const count = ordered.length;
  return {
    kind: 'internal-paused-digest',
    tag: 'internal:paused-digest',
    fields: {
      pausedAt: options.pausedAt,
      resumedAt: options.resumedAt,
      count: String(count),
      omitted: String(omitted),
      path: options.path,
      summary: `${count} notifications arrived while paused`,
    },
    intent: 'triage',
    body,
  };
}

/**
 * The read-more file: every deferred entry of the session, untruncated, grouped
 * by worker (workers in order of their first entry), chronological within a
 * worker, each entry rendered exactly as in the digest.
 */
export function composeDeferredReadMore(
  entries: readonly PausedDigestEntry[],
  options: Pick<PausedDigestOptions, 'pausedAt' | 'resumedAt'>,
): string {
  const ordered = oldestFirst(entries);
  const byWorker = new Map<string, PausedDigestEntry[]>();
  for (const entry of ordered) {
    const group = byWorker.get(entry.workerId);
    if (group) group.push(entry);
    else byWorker.set(entry.workerId, [entry]);
  }

  const lines = [
    '# Notifications that arrived while the session was paused',
    '',
    `pausedAt: ${options.pausedAt}`,
    `resumedAt: ${options.resumedAt}`,
    `count: ${ordered.length}`,
  ];
  for (const [workerId, group] of byWorker) {
    lines.push('', `## Worker ${workerId} (${group.length})`, '');
    for (const entry of group) lines.push(`- ${renderEntry(entry)}`);
  }
  return `${lines.join('\n')}\n`;
}
