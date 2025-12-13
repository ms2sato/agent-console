/**
 * GitDiffService manages git diff operations for GitDiffWorker.
 *
 * Responsibilities:
 * - Calculate base commit (merge-base with default branch)
 * - Compute diff data (summary + raw diff)
 * - Parse staging status
 * - File watching for auto-updates (optional, via chokidar or similar)
 */

import type { GitDiffData, GitDiffSummary, GitDiffFile, GitFileStatus, GitStageState } from '@agent-console/shared';
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
import { join } from 'path';

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

    // Generate diff lines
    const diffLines = [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      'index 0000000..0000000',
      '--- /dev/null',
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${lineCount} @@`,
    ];

    // Add content lines with + prefix
    for (let i = 0; i < lineCount; i++) {
      diffLines.push(`+${lines[i]}`);
    }

    // Add "No newline at end of file" if applicable
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
    console.warn(`[GitDiffService] Failed to read untracked file ${filePath}:`, error);
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
 * @returns GitDiffData containing summary and raw diff
 */
export async function getDiffData(repoPath: string, baseCommit: string): Promise<GitDiffData> {
  // Get raw diff (from baseCommit to working directory)
  let rawDiff: string;
  try {
    rawDiff = await getDiff(baseCommit, undefined, repoPath);
  } catch {
    rawDiff = '';
  }

  // Get numstat for statistics
  let numstatOutput: string;
  try {
    numstatOutput = await getDiffNumstat(baseCommit, undefined, repoPath);
  } catch {
    numstatOutput = '';
  }

  // Get status to understand staged/unstaged
  let statusOutput: string;
  try {
    statusOutput = await getStatusPorcelain(repoPath);
  } catch {
    statusOutput = '';
  }

  // Get untracked files
  let untrackedFiles: string[];
  try {
    untrackedFiles = await getUntrackedFiles(repoPath);
  } catch {
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
      stageState: determineStageState(path, statusMap, isInCommittedDiff),
      oldPath,
      additions: stats.additions,
      deletions: stats.deletions,
      isBinary: stats.isBinary,
    });

    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;
  }

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

  // Sort files by path
  files.sort((a, b) => a.path.localeCompare(b.path));

  const summary: GitDiffSummary = {
    baseCommit,
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
  } catch {
    return '';
  }
}

// ============================================================
// File Watching (placeholder for chokidar integration)
// ============================================================

type FileChangeCallback = () => void;

interface WatcherState {
  // Placeholder for chokidar watcher instance
  // watcher: FSWatcher;
  callback: FileChangeCallback;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, WatcherState>();

/**
 * Start watching a repository for file changes.
 * Uses debounced callbacks to avoid excessive updates.
 *
 * Note: This is a placeholder implementation. For production use,
 * integrate chokidar for proper file system watching.
 *
 * @param repoPath - Path to the git repository
 * @param onChange - Callback when files change
 */
export function startWatching(repoPath: string, onChange: FileChangeCallback): void {
  // Stop any existing watcher
  stopWatching(repoPath);

  // For now, store callback for manual refresh
  // TODO: Integrate chokidar for real-time file watching
  watchers.set(repoPath, {
    callback: onChange,
    debounceTimer: null,
  });

  console.log(`[GitDiffService] Watching started for: ${repoPath}`);
}

/**
 * Stop watching a repository.
 *
 * @param repoPath - Path to the git repository
 */
export function stopWatching(repoPath: string): void {
  const state = watchers.get(repoPath);
  if (state) {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    // TODO: Close chokidar watcher
    watchers.delete(repoPath);
    console.log(`[GitDiffService] Watching stopped for: ${repoPath}`);
  }
}

/**
 * Check if a repository is being watched.
 */
export function isWatching(repoPath: string): boolean {
  return watchers.has(repoPath);
}

/**
 * Trigger a refresh for watched repository (for testing/manual refresh).
 */
export function triggerRefresh(repoPath: string): void {
  const state = watchers.get(repoPath);
  if (state) {
    // Debounce the callback
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => {
      state.callback();
      state.debounceTimer = null;
    }, 100); // 100ms debounce
  }
}
