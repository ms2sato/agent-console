/**
 * GitDiffService manages git diff operations for GitDiffWorker.
 *
 * Responsibilities:
 * - Calculate base commit (merge-base with default branch)
 * - Compute diff data (summary + raw diff)
 * - Parse staging status
 * - File watching for auto-updates (optional, via chokidar or similar)
 */

import type { GitDiffData, GitDiffSummary, GitDiffFile, GitFileStatus, GitStageState, GitDiffTarget } from '@agent-console/shared';
import {
  getDefaultBranch,
  getMergeBaseSafe,
  getDiff,
  getDiffNumstat,
  getStatusPorcelain,
  getUntrackedFiles,
  gitSafe,
} from '../lib/git.js';
import { readFile, stat } from 'fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'path';
import { createLogger } from '../lib/logger.js';
import { fileWatchIgnorePatterns } from '../lib/server-config.js';

const logger = createLogger('git-diff-service');

// ============================================================
// Types
// ============================================================

interface FileStatusInfo {
  staged: boolean;
  unstaged: boolean;
  status: GitFileStatus;
  oldPath?: string;
}

// ============================================================
// Core Functions
// ============================================================

/**
 * Calculate the base commit for diff comparison.
 * Uses merge-base between default branch (main/master) and HEAD.
 *
 * @param repoPath - Path to the git repository
 * @returns Base commit hash, or null if cannot be determined
 */
export async function calculateBaseCommit(repoPath: string): Promise<string | null> {
  const defaultBranch = await getDefaultBranch(repoPath);
  if (!defaultBranch) {
    // If no default branch, fall back to first commit
    const firstCommit = await gitSafe(['rev-list', '--max-parents=0', 'HEAD'], repoPath);
    return firstCommit;
  }

  // Get merge-base between default branch and HEAD
  const mergeBase = await getMergeBaseSafe(defaultBranch, 'HEAD', repoPath);
  return mergeBase;
}

/**
 * Resolve a ref (branch name or commit hash) to its commit hash.
 *
 * @param ref - Branch name or commit hash
 * @param repoPath - Path to the git repository
 * @returns Resolved commit hash, or null if invalid
 */
export async function resolveRef(ref: string, repoPath: string): Promise<string | null> {
  return gitSafe(['rev-parse', ref], repoPath);
}

/**
 * Parse git status porcelain output to understand staged/unstaged state.
 *
 * Format: XY filename
 * Where X is the staged status and Y is the unstaged status.
 * ' ' = unmodified, M = modified, A = added, D = deleted, R = renamed, C = copied, U = unmerged
 * ? = untracked, ! = ignored
 */
function parseStatusPorcelain(statusOutput: string): Map<string, FileStatusInfo> {
  const fileMap = new Map<string, FileStatusInfo>();

  for (const line of statusOutput.split('\n')) {
    if (!line) continue;

    const indexStatus = line[0]; // Staged status
    const worktreeStatus = line[1]; // Unstaged status
    let filename = line.slice(3); // Rest is filename

    // Handle renamed files (format: "R  old -> new")
    let oldPath: string | undefined;
    if (filename.includes(' -> ')) {
      const parts = filename.split(' -> ');
      oldPath = parts[0];
      filename = parts[1];
    }

    // Determine status
    let status: GitFileStatus;
    if (indexStatus === '?' || worktreeStatus === '?') {
      status = 'untracked';
    } else if (indexStatus === 'A' || worktreeStatus === 'A') {
      status = 'added';
    } else if (indexStatus === 'D' || worktreeStatus === 'D') {
      status = 'deleted';
    } else if (indexStatus === 'R' || worktreeStatus === 'R') {
      status = 'renamed';
    } else if (indexStatus === 'C' || worktreeStatus === 'C') {
      status = 'copied';
    } else {
      status = 'modified';
    }

    const staged = indexStatus !== ' ' && indexStatus !== '?';
    const unstaged = worktreeStatus !== ' ' && worktreeStatus !== '?';

    fileMap.set(filename, { staged, unstaged, status, oldPath });
  }

  return fileMap;
}

/**
 * Determine the stage state for a file.
 */
function determineStageState(
  path: string,
  statusMap: Map<string, FileStatusInfo>,
  isInCommittedDiff: boolean
): GitStageState {
  const statusInfo = statusMap.get(path);

  if (!statusInfo) {
    // File is only in committed diff (not in working tree changes)
    return 'committed';
  }

  if (statusInfo.staged && statusInfo.unstaged) {
    return 'partial';
  }
  if (statusInfo.staged) {
    return 'staged';
  }
  if (statusInfo.unstaged) {
    return 'unstaged';
  }
  // File is tracked but no working tree changes
  return isInCommittedDiff ? 'committed' : 'unstaged';
}

/**
 * Check if a file is likely binary based on content.
 * A file is considered binary if it contains null bytes.
 */
function isBinaryContent(content: Buffer): boolean {
  // Check first 8KB for null bytes (common heuristic for binary detection)
  const checkLength = Math.min(content.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (content[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Generate diff for an untracked file (new file not yet added to git).
 * Format mimics git diff output for new files.
 *
 * @param filePath - Path to the file (relative to repo root)
 * @param repoPath - Path to the git repository
 * @returns Object containing diff string, line count, and binary flag
 */
async function generateUntrackedFileDiff(
  filePath: string,
  repoPath: string
): Promise<{ diff: string; lineCount: number; isBinary: boolean }> {
  try {
    const fullPath = join(repoPath, filePath);
    const fileStats = await stat(fullPath);

    // Skip directories
    if (fileStats.isDirectory()) {
      return { diff: '', lineCount: 0, isBinary: false };
    }

    const contentBuffer = await readFile(fullPath);

    // Check for binary file
    if (isBinaryContent(contentBuffer)) {
      const diff = [
        `diff --git a/${filePath} b/${filePath}`,
        'new file mode 100644',
        `Binary files /dev/null and b/${filePath} differ`,
        '',
      ].join('\n');
      return { diff, lineCount: 0, isBinary: true };
    }

    const content = contentBuffer.toString('utf-8');
    const lines = content.split('\n');

    // Handle trailing newline
    const hasTrailingNewline = content.endsWith('\n');
    const lineCount = hasTrailingNewline && lines[lines.length - 1] === ''
      ? lines.length - 1
      : lines.length;

    if (lineCount === 0) {
      // Empty file
      const diff = [
        `diff --git a/${filePath} b/${filePath}`,
        'new file mode 100644',
        'index 0000000..e69de29',
        '--- /dev/null',
        `+++ b/${filePath}`,
        '',
      ].join('\n');
      return { diff, lineCount: 0, isBinary: false };
    }

    // Build content lines with + prefix
    const contentLines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      contentLines.push(`+${lines[i]}`);
    }

    // Generate diff lines
    // Note: The hunk header line count must match the actual number of added lines (lines starting with '+')
    const diffLines = [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      'index 0000000..0000000',
      '--- /dev/null',
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${contentLines.length} @@`,
      ...contentLines,
    ];

    // Add "No newline at end of file" if applicable
    // Note: This line does NOT count toward hunk line count - it's metadata
    if (!hasTrailingNewline && lineCount > 0) {
      diffLines.push('\\ No newline at end of file');
    }

    return {
      diff: diffLines.join('\n') + '\n',
      lineCount,
      isBinary: false,
    };
  } catch (error) {
    // File might have been deleted or is not readable
    logger.warn({ error, filePath }, 'Failed to read untracked file');
    return { diff: '', lineCount: 0, isBinary: false };
  }
}

/**
 * Parse diff --numstat output to get file statistics.
 *
 * Format: additions<TAB>deletions<TAB>filename
 * Binary files show: -<TAB>-<TAB>filename
 */
function parseNumstat(numstatOutput: string): Map<string, { additions: number; deletions: number; isBinary: boolean }> {
  const fileStats = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();

  for (const line of numstatOutput.split('\n')) {
    if (!line) continue;

    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [adds, dels, ...filenameParts] = parts;
    const filename = filenameParts.join('\t'); // Handle filenames with tabs

    const isBinary = adds === '-' && dels === '-';
    fileStats.set(filename, {
      additions: isBinary ? 0 : parseInt(adds, 10),
      deletions: isBinary ? 0 : parseInt(dels, 10),
      isBinary,
    });
  }

  return fileStats;
}

/**
 * Get diff data for a repository from a base commit.
 *
 * @param repoPath - Path to the git repository
 * @param baseCommit - Base commit hash for comparison
 * @param targetRef - Target reference: 'working-dir' (default) or a commit hash
 * @returns GitDiffData containing summary and raw diff
 */
export async function getDiffData(
  repoPath: string,
  baseCommit: string,
  targetRef: GitDiffTarget = 'working-dir'
): Promise<GitDiffData> {
  const isWorkingDir = targetRef === 'working-dir';
  const gitTargetRef = isWorkingDir ? undefined : targetRef;

  // Get raw diff (from baseCommit to target)
  let rawDiff: string;
  try {
    rawDiff = await getDiff(baseCommit, gitTargetRef, repoPath);
  } catch (error) {
    logger.warn({ error, repoPath, baseCommit, targetRef: gitTargetRef }, 'Git diff failed, using empty diff');
    rawDiff = '';
  }

  // Get numstat for statistics
  let numstatOutput: string;
  try {
    numstatOutput = await getDiffNumstat(baseCommit, gitTargetRef, repoPath);
  } catch (error) {
    logger.warn({ error, repoPath, baseCommit, targetRef: gitTargetRef }, 'Git diff numstat failed, using empty output');
    numstatOutput = '';
  }

  // Get status to understand staged/unstaged (only relevant when comparing to working-dir)
  let statusOutput: string;
  let untrackedFiles: string[];
  if (isWorkingDir) {
    try {
      statusOutput = await getStatusPorcelain(repoPath);
    } catch (error) {
      logger.warn({ error, repoPath }, 'Git status porcelain failed, using empty output');
      statusOutput = '';
    }

    try {
      untrackedFiles = await getUntrackedFiles(repoPath);
    } catch (error) {
      logger.warn({ error, repoPath }, 'Git untracked files failed, using empty list');
      untrackedFiles = [];
    }
  } else {
    // When comparing commit to commit, status info is not applicable
    statusOutput = '';
    untrackedFiles = [];
  }

  // Parse data
  const fileStats = parseNumstat(numstatOutput);
  const statusMap = parseStatusPorcelain(statusOutput);

  // Build file list from numstat (committed + staged + unstaged tracked changes)
  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  // Add files from diff (committed changes since baseCommit)
  for (const [path, stats] of fileStats) {
    const statusInfo = statusMap.get(path);
    const isInCommittedDiff = true;

    // Determine file status
    let status: GitFileStatus = 'modified';
    let oldPath: string | undefined;

    if (statusInfo) {
      status = statusInfo.status;
      oldPath = statusInfo.oldPath;
    }

    files.push({
      path,
      status,
      stageState: isWorkingDir ? determineStageState(path, statusMap, isInCommittedDiff) : 'committed',
      oldPath,
      additions: stats.additions,
      deletions: stats.deletions,
      isBinary: stats.isBinary,
    });

    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;
  }

  // When comparing to working directory, add staged files and untracked files
  if (isWorkingDir) {
    // Add staged files that aren't in committed diff
    for (const [path, info] of statusMap) {
      if (!fileStats.has(path) && info.staged) {
        files.push({
          path,
          status: info.status,
          stageState: 'staged',
          oldPath: info.oldPath,
          additions: 0,
          deletions: 0,
          isBinary: false,
        });
      }
    }

    // Add untracked files with their diff content
    // Note: untracked files are in statusMap (from git status --porcelain with ?? status)
    // but NOT in fileStats (from git diff --numstat), so we only check fileStats
    const untrackedDiffs: string[] = [];
    for (const path of untrackedFiles) {
      if (!fileStats.has(path)) {
        // Generate diff for this untracked file
        const { diff, lineCount, isBinary } = await generateUntrackedFileDiff(path, repoPath);

        files.push({
          path,
          status: 'untracked',
          stageState: 'unstaged',
          additions: lineCount,
          deletions: 0,
          isBinary,
        });

        // Update totals
        totalAdditions += lineCount;

        // Collect diff for appending to rawDiff
        if (diff) {
          untrackedDiffs.push(diff);
        }
      }
    }

    // Append untracked file diffs to rawDiff
    if (untrackedDiffs.length > 0) {
      rawDiff = rawDiff + (rawDiff && !rawDiff.endsWith('\n') ? '\n' : '') + untrackedDiffs.join('');
    }
  }

  // Sort files by path
  files.sort((a, b) => a.path.localeCompare(b.path));

  const summary: GitDiffSummary = {
    baseCommit,
    targetRef,
    files,
    totalAdditions,
    totalDeletions,
    updatedAt: new Date().toISOString(),
  };

  return {
    summary,
    rawDiff,
  };
}

/**
 * Validate that a file path is safe and doesn't escape the repository directory.
 * Prevents path traversal attacks via malicious filePath parameter.
 */
function isValidFilePath(filePath: string): boolean {
  // Reject absolute paths
  if (filePath.startsWith('/') || filePath.startsWith('\\')) {
    return false;
  }
  // Reject paths containing .. (path traversal)
  if (filePath.includes('..')) {
    return false;
  }
  // Reject paths with null bytes (security concern)
  if (filePath.includes('\0')) {
    return false;
  }
  return true;
}

/**
 * Get diff for a specific file.
 *
 * @param repoPath - Path to the git repository
 * @param baseCommit - Base commit hash for comparison
 * @param filePath - Path to the file (relative to repo root)
 * @returns Raw diff text for the file, or empty string if no changes
 */
export async function getFileDiff(
  repoPath: string,
  baseCommit: string,
  filePath: string
): Promise<string> {
  // SECURITY: Validate filePath to prevent path traversal attacks
  if (!isValidFilePath(filePath)) {
    logger.warn({ filePath }, 'Invalid file path in getFileDiff');
    return '';
  }

  try {
    // Get diff for specific file
    const rawDiff = await getDiff(baseCommit, undefined, repoPath);

    // Extract the portion for this file from the unified diff
    // This is a simplified approach - we just filter the raw diff
    const lines = rawDiff.split('\n');
    const fileLines: string[] = [];
    let inTargetFile = false;
    let foundDiff = false;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        // Check if this is our target file
        const match = line.match(/diff --git a\/(.*) b\/(.*)/);
        if (match) {
          const aPath = match[1];
          const bPath = match[2];
          inTargetFile = aPath === filePath || bPath === filePath;
          if (inTargetFile) {
            foundDiff = true;
            fileLines.push(line);
          }
        }
      } else if (inTargetFile) {
        // Check if we've reached the next file
        if (line.startsWith('diff --git')) {
          break;
        }
        fileLines.push(line);
      }
    }

    if (foundDiff) {
      return fileLines.join('\n');
    }

    // File not found in regular diff - check if it's an untracked file
    const untrackedFiles = await getUntrackedFiles(repoPath);
    if (untrackedFiles.includes(filePath)) {
      const { diff } = await generateUntrackedFileDiff(filePath, repoPath);
      return diff;
    }

    return '';
  } catch (error) {
    logger.warn({ error, repoPath, baseCommit, filePath }, 'Git file diff failed, returning empty');
    return '';
  }
}

// ============================================================
// File Watching (using Bun-native fs.watch)
// ============================================================

type FileChangeCallback = () => void;

/** Debounce delay for file change notifications (ms) */
const DEBOUNCE_DELAY = 300;

interface WatcherState {
  watcher: FSWatcher;
  callback: FileChangeCallback;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, WatcherState>();

/**
 * Check if a filename should be ignored based on configured patterns.
 * Uses simple string matching for performance.
 */
function shouldIgnore(filename: string | null): boolean {
  if (!filename) return true;
  return fileWatchIgnorePatterns.some(pattern => filename.includes(pattern));
}

/**
 * Start watching a repository for file changes.
 * Uses Bun-native fs.watch for efficient file system watching with debounced callbacks.
 *
 * @param repoPath - Path to the git repository
 * @param onChange - Callback when files change (debounced)
 */
export function startWatching(repoPath: string, onChange: FileChangeCallback): void {
  // Stop any existing watcher for this path
  stopWatching(repoPath);

  const log = logger.child({ repoPath });

  try {
    const state: WatcherState = {
      watcher: null as unknown as FSWatcher, // Will be set below
      callback: onChange,
      debounceTimer: null,
    };

    // Create fs.watch watcher with recursive option
    const watcher = watch(repoPath, { recursive: true }, (eventType, filename) => {
      if (shouldIgnore(filename)) return;

      log.debug({ eventType, filename }, 'File change detected');

      // Clear existing timer
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }

      // Set new debounced callback
      state.debounceTimer = setTimeout(() => {
        log.debug('Triggering diff refresh after debounce');
        state.callback();
        state.debounceTimer = null;
      }, DEBOUNCE_DELAY);
    });

    watcher.on('error', (error) => {
      log.error({ error }, 'File watcher error');
    });

    state.watcher = watcher;
    watchers.set(repoPath, state);
    log.info('File watching started');
  } catch (error) {
    log.error({ error }, 'Failed to start file watching');
    throw error;
  }
}

/**
 * Stop watching a repository and clean up resources.
 *
 * @param repoPath - Path to the git repository
 */
export function stopWatching(repoPath: string): void {
  const state = watchers.get(repoPath);
  if (state) {
    const log = logger.child({ repoPath });

    // Clear any pending debounce timer
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    // Close the fs.watch watcher
    state.watcher.close();

    watchers.delete(repoPath);
    log.info('File watching stopped');
  }
}

/**
 * Check if a repository is being watched.
 */
export function isWatching(repoPath: string): boolean {
  return watchers.has(repoPath);
}

/**
 * Trigger a manual refresh for a watched repository.
 * Useful for testing or when a manual refresh is requested.
 *
 * @param repoPath - Path to the git repository
 */
export function triggerRefresh(repoPath: string): void {
  const state = watchers.get(repoPath);
  if (state) {
    // Clear existing timer and trigger immediately with short debounce
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => {
      state.callback();
      state.debounceTimer = null;
    }, 100);
  }
}
