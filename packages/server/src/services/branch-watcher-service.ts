/**
 * BranchWatcherService - Monitors git HEAD files to detect branch changes.
 *
 * Watches the HEAD file for each worktree session via fs.watch.
 * When a branch change is detected, updates worktreeId in memory,
 * persists to database, and broadcasts to connected clients.
 *
 * HEAD file locations:
 * - Main repository: <locationPath>/.git/HEAD
 * - Git worktree: <main-repo>/.git/worktrees/<basename>/HEAD
 */

import { watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('branch-watcher');

const DEBOUNCE_DELAY = 200;

/** Parse branch name from HEAD file content. */
export function parseBranchFromHead(content: string): string {
  const trimmed = content.trim();
  const refPrefix = 'ref: refs/heads/';
  if (trimmed.startsWith(refPrefix)) {
    return trimmed.slice(refPrefix.length);
  }
  // Detached HEAD (raw commit hash or other)
  return '(detached)';
}

/**
 * Resolve the path to the HEAD file for a given locationPath.
 *
 * For git worktrees, the .git entry is a file containing "gitdir: <path>".
 * We read that to find the actual git directory, which contains the HEAD file.
 *
 * For main repositories, .git is a directory and HEAD is at .git/HEAD.
 */
export async function resolveHeadFilePath(locationPath: string): Promise<string | null> {
  const dotGitPath = path.join(locationPath, '.git');

  // Try reading .git as a file (worktree case: contains "gitdir: <path>")
  // Uses Bun.file() to avoid node:fs/promises mock contamination in tests
  try {
    const content = await Bun.file(dotGitPath).text();
    if (content.startsWith('gitdir: ')) {
      const gitdir = content.slice('gitdir: '.length).trim();
      const resolvedGitdir = path.isAbsolute(gitdir)
        ? gitdir
        : path.resolve(locationPath, gitdir);
      return path.join(resolvedGitdir, 'HEAD');
    }
  } catch {
    // Not a readable file — may be a directory or not exist
  }

  // Main repository: HEAD is at .git/HEAD
  const headPath = path.join(dotGitPath, 'HEAD');
  if (await Bun.file(headPath).exists()) {
    return headPath;
  }

  return null;
}

/**
 * Read the current branch from a HEAD file path.
 */
async function readBranchFromHeadFile(headFilePath: string): Promise<string | null> {
  try {
    const content = await Bun.file(headFilePath).text();
    return parseBranchFromHead(content);
  } catch {
    return null;
  }
}

interface WatcherEntry {
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  currentBranch: string;
  /** Serialization lock: when set, a sync is in progress. Next change waits. */
  syncInProgress: boolean;
  /** Whether another change arrived during an in-progress sync. */
  pendingRecheck: boolean;
}

export interface BranchChangeCallback {
  (sessionId: string, newBranch: string): Promise<void>;
}

type WatchFn = typeof watch;

export class BranchWatcherService {
  private watchers = new Map<string, WatcherEntry>();
  private watchFn: WatchFn;

  constructor(
    private readonly onBranchChanged: BranchChangeCallback,
    watchFn?: WatchFn,
  ) {
    this.watchFn = watchFn ?? watch;
  }

  /**
   * Start watching the HEAD file for a session.
   * If already watching this session, stops the previous watcher first.
   *
   * Reads the actual HEAD file to seed the watcher with the real current branch,
   * and triggers onBranchChanged if it differs from the provided currentBranch.
   */
  async startWatching(sessionId: string, locationPath: string, currentBranch: string): Promise<void> {
    // Stop any existing watcher for this session
    this.stopWatching(sessionId);

    const headFilePath = await resolveHeadFilePath(locationPath);
    if (!headFilePath) {
      logger.warn({ sessionId, locationPath }, 'Could not resolve HEAD file path, skipping branch watch');
      return;
    }

    // Read actual HEAD to seed the watcher from reality, not stale metadata
    const actualBranch = await readBranchFromHeadFile(headFilePath);
    if (actualBranch === null) {
      logger.warn({ sessionId, headFilePath }, 'HEAD file not readable, skipping branch watch');
      return;
    }

    // If stored branch differs from actual HEAD, reconcile immediately
    if (actualBranch !== currentBranch) {
      logger.info({ sessionId, storedBranch: currentBranch, actualBranch }, 'Reconciling stale branch on watcher start');
      try {
        await this.onBranchChanged(sessionId, actualBranch);
      } catch (error) {
        logger.error({ sessionId, err: error }, 'Failed to reconcile stale branch');
      }
    }

    const entry: WatcherEntry = {
      watcher: null as unknown as FSWatcher,
      debounceTimer: null,
      currentBranch: actualBranch,
      syncInProgress: false,
      pendingRecheck: false,
    };

    // Watch the parent directory rather than the HEAD file directly.
    // Git updates HEAD via atomic rename (HEAD.lock -> HEAD), which detaches
    // the original inode. fs.watch on a file is bound to the inode, so it
    // would miss updates after the first rename. Directory watchers persist
    // across file replacements. (Issue #708)
    const headDir = path.dirname(headFilePath);
    const headBasename = path.basename(headFilePath);

    try {
      const fsWatcher = this.watchFn(headDir, (_eventType, filename) => {
        // Filter: only react to events for the HEAD file itself.
        // Directory watcher also fires for HEAD.lock, index, ORIG_HEAD, etc.
        // Some platforms pass null filename — ignore those (cannot disambiguate).
        if (filename !== headBasename) return;

        // Debounce: git may write HEAD multiple times during a single operation
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
        }
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          this.serializedHeadChange(sessionId, headFilePath, entry);
        }, DEBOUNCE_DELAY);
      });

      fsWatcher.on('error', (error) => {
        logger.error({ sessionId, headDir, err: error }, 'HEAD file watcher error');
      });

      entry.watcher = fsWatcher;
      this.watchers.set(sessionId, entry);

      logger.info({ sessionId, headFilePath, headDir, currentBranch: actualBranch }, 'Started watching HEAD file');
    } catch (error) {
      logger.error({ sessionId, headDir, err: error }, 'Failed to start HEAD file watcher');
    }
  }

  /**
   * Stop watching the HEAD file for a session.
   */
  stopWatching(sessionId: string): void {
    const entry = this.watchers.get(sessionId);
    if (!entry) return;

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    entry.watcher.close();
    this.watchers.delete(sessionId);

    logger.info({ sessionId }, 'Stopped watching HEAD file');
  }

  /**
   * Stop all watchers. Called on server shutdown.
   */
  stopAll(): void {
    for (const [sessionId, entry] of this.watchers) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      entry.watcher.close();
      logger.debug({ sessionId }, 'Stopped HEAD watcher (shutdown)');
    }
    this.watchers.clear();
  }

  /**
   * Check if a session is being watched.
   */
  isWatching(sessionId: string): boolean {
    return this.watchers.has(sessionId);
  }

  /**
   * Serialize sync operations per entry to prevent parallel handleHeadChange runs.
   */
  private async serializedHeadChange(sessionId: string, headFilePath: string, entry: WatcherEntry): Promise<void> {
    if (entry.syncInProgress) {
      entry.pendingRecheck = true;
      return;
    }

    entry.syncInProgress = true;
    try {
      await this.handleHeadChange(sessionId, headFilePath, entry);
    } finally {
      entry.syncInProgress = false;

      // If another change arrived during sync, process it
      if (entry.pendingRecheck) {
        entry.pendingRecheck = false;
        await this.serializedHeadChange(sessionId, headFilePath, entry);
      }
    }
  }

  private async handleHeadChange(sessionId: string, headFilePath: string, entry: WatcherEntry): Promise<void> {
    try {
      const content = await Bun.file(headFilePath).text();
      const newBranch = parseBranchFromHead(content);

      if (newBranch === entry.currentBranch) {
        return; // No change
      }

      const oldBranch = entry.currentBranch;

      logger.info({ sessionId, oldBranch, newBranch }, 'Branch change detected');

      // Call onBranchChanged first; only update currentBranch on success
      await this.onBranchChanged(sessionId, newBranch);
      entry.currentBranch = newBranch;
    } catch (error) {
      logger.error({ sessionId, headFilePath, err: error }, 'Failed to handle HEAD change');
    }
  }
}
