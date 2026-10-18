/**
 * Shared recursive file watcher with a refcounted subscriber set.
 *
 * One recursive `fs.watch` is opened per watched path by the first subscriber
 * and closed by the last unsubscribe. Each subscriber owns its ignore rule,
 * its trailing debounce (plus an optional maximum wait) and its own batch of
 * distinct changed paths, so the git diff worker and the file viewer worker
 * can watch the same directory without replacing each other
 * (docs/design/file-viewer-worker.md, "Live updates").
 */

import { watch as fsWatch } from 'node:fs';
import { sep } from 'node:path';
import { createLogger } from '../lib/logger.js';
import { isErrnoException } from '../lib/type-guards.js';

const logger = createLogger('file-watch-service');

export type FileWatchFailureReason = 'permission-denied' | 'watch-failed';

export interface FileChangeBatch {
  /** Distinct changed paths, relative to the watched path, `/`-separated. */
  paths: string[];
  /** True when more distinct paths changed than `maxPaths` keeps. */
  overflow: boolean;
}

export interface FileChangeSubscriber {
  /** True for a path (`/`-separated, relative to the watched path) this subscriber does not want. */
  ignore: (relPath: string) => boolean;
  /** Trailing debounce, reset by every non-ignored event. */
  debounceMs: number;
  /** Cap from the first event of a window to delivery; null = no cap. */
  maxWaitMs: number | null;
  /** Distinct paths kept per batch; a further distinct path sets `overflow`. */
  maxPaths: number;
  onChange: (batch: FileChangeBatch) => void;
  /** Called at most once per subscription, after which the subscription delivers nothing. */
  onError: (reason: FileWatchFailureReason) => void;
}

/** What this service needs of a watcher: an error hook and a close. `fs.FSWatcher` satisfies it. */
export interface FileWatcher {
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): void;
}

/** The `fs.watch` call this service makes (recursive, string filenames), narrowed so a test fake needs no cast. */
export type FileWatchFn = (
  path: string,
  options: { recursive: true },
  listener: (eventType: string, filename: string | null) => void,
) => FileWatcher;

export interface FileWatchDeps {
  watch?: FileWatchFn;
}

const defaultWatch: FileWatchFn = (path, options, listener) => fsWatch(path, options, listener);

interface Subscription {
  subscriber: FileChangeSubscriber;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  paths: Set<string>;
  overflow: boolean;
  closed: boolean;
}

interface WatchEntry {
  watcher: FileWatcher;
  subscriptions: Set<Subscription>;
}

const entries = new Map<string, WatchEntry>();

/**
 * A pattern that starts with `.` names an extension (or dot-file suffix) and
 * matches a segment that ends with it; every other pattern matches a segment
 * equal to it. Matching on whole segments keeps `catalog.logic.ts` from being
 * taken for a `.log` file.
 */
export function matchesIgnorePattern(pattern: string, segment: string): boolean {
  if (pattern.startsWith('.')) return segment.endsWith(pattern);
  return segment === pattern;
}

/** True when any `/`-segment of `relPath` matches any of `patterns`. */
export function pathHasIgnoredSegment(relPath: string, patterns: readonly string[]): boolean {
  if (relPath === '') return false;
  const segments = relPath.split('/');
  return segments.some((segment) => segment !== '' && patterns.some((pattern) => matchesIgnorePattern(pattern, segment)));
}

function clearTimers(sub: Subscription): void {
  if (sub.debounceTimer) clearTimeout(sub.debounceTimer);
  if (sub.maxWaitTimer) clearTimeout(sub.maxWaitTimer);
  sub.debounceTimer = null;
  sub.maxWaitTimer = null;
}

function deliver(sub: Subscription): void {
  clearTimers(sub);
  if (sub.closed || sub.paths.size === 0) return;
  const batch: FileChangeBatch = { paths: [...sub.paths], overflow: sub.overflow };
  sub.paths = new Set();
  sub.overflow = false;
  try {
    sub.subscriber.onChange(batch);
  } catch (error) {
    logger.error({ error }, 'File change subscriber threw');
  }
}

function fail(sub: Subscription, reason: FileWatchFailureReason): void {
  if (sub.closed) return;
  sub.closed = true;
  clearTimers(sub);
  try {
    sub.subscriber.onError(reason);
  } catch (error) {
    logger.error({ error }, 'File change error handler threw');
  }
}

function record(sub: Subscription, relPath: string): void {
  const { subscriber } = sub;
  if (sub.paths.has(relPath)) {
    // already counted
  } else if (sub.paths.size >= subscriber.maxPaths) {
    sub.overflow = true;
  } else {
    sub.paths.add(relPath);
  }
  if (sub.debounceTimer) clearTimeout(sub.debounceTimer);
  sub.debounceTimer = setTimeout(() => deliver(sub), subscriber.debounceMs);
  if (subscriber.maxWaitMs !== null && !sub.maxWaitTimer) {
    sub.maxWaitTimer = setTimeout(() => deliver(sub), subscriber.maxWaitMs);
  }
}

function handleEvent(subscriptions: ReadonlySet<Subscription>, filename: string | null): void {
  // A null filename carries no path to match an ignore rule against.
  if (filename === null || filename === undefined) return;
  const relPath = sep === '/' ? filename : filename.split(sep).join('/');
  for (const sub of subscriptions) {
    if (sub.closed || sub.subscriber.ignore(relPath)) continue;
    record(sub, relPath);
  }
}

/**
 * Subscribe to changes under `watchPath`. Returns an idempotent unsubscribe;
 * after it runs no `onChange` fires. When the watch cannot be opened (or later
 * errors) `onError` is called once and the subscription delivers nothing.
 */
export function subscribeToFileChanges(
  watchPath: string,
  subscriber: FileChangeSubscriber,
  deps: FileWatchDeps = {},
): () => void {
  const sub: Subscription = {
    subscriber,
    debounceTimer: null,
    maxWaitTimer: null,
    paths: new Set(),
    overflow: false,
    closed: false,
  };

  let entry = entries.get(watchPath);
  if (!entry) {
    const watchFn = deps.watch ?? defaultWatch;
    // The subscriptions set exists before the watcher so the event callback can close over it; the entry
    // is built only once the watcher exists, so it is never partially constructed.
    const subscriptions = new Set<Subscription>();
    let watcher: FileWatcher;
    try {
      watcher = watchFn(watchPath, { recursive: true }, (_eventType, filename) => {
        handleEvent(subscriptions, filename);
      });
    } catch (error) {
      const code = isErrnoException(error) ? error.code : undefined;
      const reason: FileWatchFailureReason = code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'watch-failed';
      logger.warn({ error, watchPath, reason }, 'Failed to start file watching');
      fail(sub, reason);
      return () => {};
    }
    const created: WatchEntry = { watcher, subscriptions };
    watcher.on('error', (error) => {
      logger.error({ error, watchPath }, 'File watcher error');
      if (entries.get(watchPath) === created) entries.delete(watchPath);
      try {
        watcher.close();
      } catch (closeError) {
        logger.warn({ closeError, watchPath }, 'Failed to close a failed file watcher');
      }
      for (const s of subscriptions) fail(s, 'watch-failed');
      subscriptions.clear();
    });
    entries.set(watchPath, created);
    entry = created;
    logger.info({ watchPath }, 'File watching started');
  }

  entry.subscriptions.add(sub);
  const owner = entry;

  return () => {
    if (sub.closed) return;
    sub.closed = true;
    clearTimers(sub);
    owner.subscriptions.delete(sub);
    if (owner.subscriptions.size === 0) {
      if (entries.get(watchPath) === owner) entries.delete(watchPath);
      owner.watcher.close();
      logger.info({ watchPath }, 'File watching stopped');
    }
  };
}
