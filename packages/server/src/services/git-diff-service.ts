/**
 * GitDiffService manages git diff operations for GitDiffWorker.
 *
 * Responsibilities:
 * - Calculate base commit (merge-base with default branch)
 * - Compute diff data (summary + raw diff)
 * - Parse staging status
 * - File watching for auto-updates (a subscriber of the shared file-watch-service)
 */

import type { GitDiffData, GitDiffSummary, GitDiffFile, GitFileStatus, GitStageState, GitDiffTarget } from '@agent-console/shared';
import { MERGE_BASE_REF_PREFIX, DEFAULT_FORK_POINT_SPEC } from '@agent-console/shared';
import {
  getDefaultBranch,
  getMergeBaseSafe,
  getDiff,
  getDiffNumstat,
  getStatusPorcelain,
  getUntrackedFiles,
  gitRaw,
  gitRefExists,
  gitSafe,
  readWorkingTreeFile,
} from '../lib/git.js';
import { isValidFilePath } from '../lib/relative-file-path.js';
import { createLogger } from '../lib/logger.js';
import { fileWatchIgnorePatterns } from '../lib/server-config.js';
import { subscribeToFileChanges, pathHasIgnoredSegment } from './file-watch-service.js';

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
 * Resolve the repository's first (root) commit hash. `rev-list --max-parents=0`
 * can emit multiple root hashes when unrelated histories were merged, so take
 * only the first line. Returns null when there is no commit.
 *
 * @param requestUser - OS username to run git as. See {@link computeDefaultBaseSpec}.
 */
async function getFirstCommit(repoPath: string, requestUser: string | null): Promise<string | null> {
  const result = await gitSafe(['rev-list', '--max-parents=0', 'HEAD'], repoPath, requestUser);
  return result?.split('\n')[0] ?? null;
}

/**
 * Resolve the repository's default fork point to a commit hash.
 *
 * Resolution chain (the first non-null wins):
 * 1. merge-base with `origin/<default>` when `origin/<default>` exists
 * 2. merge-base with the local `<default>` branch when a default branch exists
 * 3. the repository's first commit (`rev-list --max-parents=0 HEAD`)
 *
 * Returns null only when every step fails (e.g. unrelated histories with no
 * default branch and no first commit).
 *
 * @param repoPath - Path to the git repository
 * @param requestUser - OS username to run git as (null = no elevation)
 * @returns Base commit hash, or null if cannot be determined
 */
async function resolveDefaultForkPoint(repoPath: string, requestUser: string | null): Promise<string | null> {
  const defaultBranch = await getDefaultBranch(repoPath, requestUser);

  if (defaultBranch) {
    const originRef = `origin/${defaultBranch}`;
    if (await gitRefExists(originRef, repoPath, requestUser)) {
      const mergeBase = await getMergeBaseSafe(originRef, 'HEAD', repoPath, requestUser);
      if (mergeBase) {
        return mergeBase;
      }
    }

    const localMergeBase = await getMergeBaseSafe(defaultBranch, 'HEAD', repoPath, requestUser);
    if (localMergeBase) {
      return localMergeBase;
    }
  }

  // No default branch (or merge-base unavailable): fall back to first commit.
  return getFirstCommit(repoPath, requestUser);
}

/**
 * Compute the concrete default base *spec* at git-diff worker creation time.
 *
 * Produces a spec (intent) that is re-resolved on every diff via
 * {@link resolveBaseSpec} — NOT a frozen commit hash. This keeps the diff base
 * tracking the moving fork point as the feature branch absorbs upstream commits.
 *
 * - `origin/<default>` exists → `merge-base:origin/<default>`
 * - default branch exists (no origin ref) → `merge-base:<default>`
 * - no default branch → the repository's first commit hash (an explicit pinned
 *   hash is correct here since there is no branch to track), or `'HEAD'` when
 *   even that cannot be resolved.
 *
 * @param repoPath - Path to the git repository
 * @param requestUser - OS username to run git as (null = no elevation). In
 *   multi-user mode this is the worktree-owning user so git does not refuse
 *   with "dubious ownership in repository".
 * @returns A base spec string (never null)
 */
export async function computeDefaultBaseSpec(repoPath: string, requestUser: string | null): Promise<string> {
  const defaultBranch = await getDefaultBranch(repoPath, requestUser);

  if (defaultBranch) {
    if (await gitRefExists(`origin/${defaultBranch}`, repoPath, requestUser)) {
      return `${MERGE_BASE_REF_PREFIX}origin/${defaultBranch}`;
    }
    return `${MERGE_BASE_REF_PREFIX}${defaultBranch}`;
  }

  // No default branch: pin to the first commit (no branch to track).
  const firstCommit = await getFirstCommit(repoPath, requestUser);
  return firstCommit ?? 'HEAD';
}

/**
 * Resolve a persisted base *spec* to a concrete commit hash at diff time.
 *
 * Spec kinds:
 * - `DEFAULT_FORK_POINT_SPEC` sentinel → the default fork-point chain
 *   (origin merge-base → local merge-base → first commit). Falls back
 *   gracefully and never hard-fails when a default exists.
 * - `merge-base:<ref>` → `git merge-base <ref> HEAD`. Returns null on genuine
 *   failure (unrelated histories / deleted ref) so the caller surfaces an error
 *   — no silent fallback for an explicit merge-base spec.
 * - branch name or explicit hash → `git rev-parse`. Branch names re-resolve to
 *   tip; hashes stay pinned.
 *
 * @param spec - The persisted base spec
 * @param repoPath - Path to the git repository
 * @param requestUser - See {@link computeDefaultBaseSpec}.
 * @returns Resolved commit hash, or null on genuine resolution failure
 */
export async function resolveBaseSpec(
  spec: string,
  repoPath: string,
  requestUser: string | null,
): Promise<string | null> {
  if (spec === DEFAULT_FORK_POINT_SPEC) {
    return resolveDefaultForkPoint(repoPath, requestUser);
  }

  if (spec.startsWith(MERGE_BASE_REF_PREFIX)) {
    const ref = spec.slice(MERGE_BASE_REF_PREFIX.length);
    return getMergeBaseSafe(ref, 'HEAD', repoPath, requestUser);
  }

  // Branch name or explicit commit hash.
  return resolveRef(spec, repoPath, requestUser);
}

/**
 * Resolve a ref (branch name or commit hash) to its commit hash.
 *
 * @param ref - Branch name or commit hash
 * @param repoPath - Path to the git repository
 * @param requestUser - See {@link computeDefaultBaseSpec}.
 * @returns Resolved commit hash, or null if invalid
 */
export async function resolveRef(
  ref: string,
  repoPath: string,
  requestUser: string | null,
): Promise<string | null> {
  return gitSafe(['rev-parse', ref], repoPath, requestUser);
}

/**
 * Remove surrounding quotes from a git filename if present.
 * Git quotes filenames containing special characters (spaces, non-ASCII, etc.)
 *
 * @param filename - The filename potentially wrapped in quotes
 * @returns The unquoted filename
 */
function unquoteFilename(filename: string): string {
  if (filename.startsWith('"') && filename.endsWith('"')) {
    return filename.slice(1, -1);
  }
  return filename;
}

/**
 * Parse the filename portion of a git status line, handling renames and quotes.
 *
 * Formats:
 * - Simple: "filename"
 * - Quoted: '"filename with spaces"'
 * - Rename: "old -> new" or '"old" -> "new"' or '"old" -> new' etc.
 *
 * @param filenamePart - The filename portion after "XY "
 * @returns Object with filename and optional oldPath for renames
 */
function parseFilenameWithRename(filenamePart: string): { filename: string; oldPath?: string } {
  // Check for rename pattern: " -> " separator
  // Handle various quote combinations:
  // - old -> new
  // - "old" -> "new"
  // - "old with space" -> new
  // - old -> "new with space"

  // Use regex to find " -> " that's not inside quotes
  // Pattern: look for " -> " but need to handle quotes properly
  const renameMatch = filenamePart.match(/^(.+?) -> (.+)$/);

  if (renameMatch) {
    const oldPart = renameMatch[1];
    const newPart = renameMatch[2];
    return {
      filename: unquoteFilename(newPart),
      oldPath: unquoteFilename(oldPart),
    };
  }

  return {
    filename: unquoteFilename(filenamePart),
  };
}

/**
 * Parse git status porcelain output to understand staged/unstaged state.
 *
 * Format: XY filename  or  XY "filename"
 * Where X is the staged status and Y is the unstaged status.
 * ' ' = unmodified, M = modified, A = added, D = deleted, R = renamed, C = copied, U = unmerged
 * ? = untracked, ! = ignored
 *
 * Git uses quotes around filenames containing special characters (spaces, non-ASCII, etc.)
 * Renames are shown as: R  old -> new  or  R  "old" -> "new"
 */
function parseStatusPorcelain(statusOutput: string): Map<string, FileStatusInfo> {
  const fileMap = new Map<string, FileStatusInfo>();

  // Regex pattern: ^XY filename$
  // X and Y are single characters, followed by a space, then the filename
  const linePattern = /^(.)(.) (.+)$/;

  for (const line of statusOutput.split('\n')) {
    if (!line) continue;

    const match = line.match(linePattern);
    if (!match) {
      // Log unexpected format for debugging
      logger.warn({ line }, 'Failed to parse git status porcelain line');
      continue;
    }

    const indexStatus = match[1]; // Staged status (X)
    const worktreeStatus = match[2]; // Unstaged status (Y)
    const filenamePart = match[3]; // Rest is filename (possibly quoted, possibly rename)

    // Parse filename, handling quotes and renames
    const { filename, oldPath } = parseFilenameWithRename(filenamePart);

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
 * @param requestUser - OS username owning the worktree; the file is read as that user.
 * @returns Object containing diff string, line count, and binary flag
 */
async function generateUntrackedFileDiff(
  filePath: string,
  repoPath: string,
  requestUser: string | null
): Promise<{ diff: string; lineCount: number; isBinary: boolean }> {
  try {
    const read = await readWorkingTreeFile(repoPath, filePath, requestUser);

    // Skip directories
    if (read?.kind === 'directory') {
      return { diff: '', lineCount: 0, isBinary: false };
    }
    if (read === null) {
      throw new Error(`File not found: ${filePath}`);
    }

    const contentBuffer = read.content;

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
 * @param requestUser - OS username to run git as. See {@link computeDefaultBaseSpec}.
 * @param targetRef - Target reference: 'working-dir' (default) or a commit hash
 * @returns GitDiffData containing summary and raw diff
 */
export async function getDiffData(
  repoPath: string,
  baseCommit: string,
  requestUser: string | null,
  targetRef: GitDiffTarget = 'working-dir'
): Promise<GitDiffData> {
  const isWorkingDir = targetRef === 'working-dir';
  const gitTargetRef = isWorkingDir ? undefined : targetRef;

  // Get raw diff (from baseCommit to target)
  let rawDiff: string;
  try {
    rawDiff = await getDiff(baseCommit, gitTargetRef, repoPath, requestUser);
  } catch (error) {
    logger.warn({ error, repoPath, baseCommit, targetRef: gitTargetRef }, 'Git diff failed, using empty diff');
    rawDiff = '';
  }

  // Get numstat for statistics
  let numstatOutput: string;
  try {
    numstatOutput = await getDiffNumstat(baseCommit, gitTargetRef, repoPath, requestUser);
  } catch (error) {
    logger.warn({ error, repoPath, baseCommit, targetRef: gitTargetRef }, 'Git diff numstat failed, using empty output');
    numstatOutput = '';
  }

  // Get status to understand staged/unstaged (only relevant when comparing to working-dir)
  let statusOutput: string;
  let untrackedFiles: string[];
  if (isWorkingDir) {
    try {
      statusOutput = await getStatusPorcelain(repoPath, requestUser);
    } catch (error) {
      logger.warn({ error, repoPath }, 'Git status porcelain failed, using empty output');
      statusOutput = '';
    }

    try {
      untrackedFiles = await getUntrackedFiles(repoPath, requestUser);
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
    // Process untracked files in parallel to avoid blocking
    const untrackedFilesToProcess = untrackedFiles.filter(path => !fileStats.has(path));
    const untrackedResults = await Promise.all(
      untrackedFilesToProcess.map(async (path) => {
        const { diff, lineCount, isBinary } = await generateUntrackedFileDiff(path, repoPath, requestUser);
        return { path, diff, lineCount, isBinary };
      })
    );

    const untrackedDiffs: string[] = [];
    for (const { path, diff, lineCount, isBinary } of untrackedResults) {
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
 * Get diff for a specific file.
 *
 * @param repoPath - Path to the git repository
 * @param baseCommit - Base commit hash for comparison
 * @param filePath - Path to the file (relative to repo root)
 * @param requestUser - OS username to run git as. See {@link computeDefaultBaseSpec}.
 * @returns Raw diff text for the file, or empty string if no changes
 */
export async function getFileDiff(
  repoPath: string,
  baseCommit: string,
  filePath: string,
  requestUser: string | null,
): Promise<string> {
  // SECURITY: Validate filePath to prevent path traversal attacks
  if (!isValidFilePath(filePath)) {
    logger.warn({ filePath }, 'Invalid file path in getFileDiff');
    return '';
  }

  try {
    // Use targeted git diff command for the specific file
    const rawDiff = await gitRaw(['diff', baseCommit, '--', filePath], repoPath, undefined, requestUser);

    if (rawDiff) {
      return rawDiff;
    }

    // File not found in regular diff - check if it's an untracked file
    const untrackedFiles = await getUntrackedFiles(repoPath, requestUser);
    if (untrackedFiles.includes(filePath)) {
      const { diff } = await generateUntrackedFileDiff(filePath, repoPath, requestUser);
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

/** Delay of a manual refresh trigger (ms) */
const MANUAL_REFRESH_DELAY = 100;

/**
 * One diff connection's subscription to the shared watcher. Several
 * connections can watch the same repository path (two browser tabs, or two
 * sessions on one directory), so each `startWatching` call keeps its own
 * subscription and returns its own unsubscribe; other subscribers of the same
 * path (the file viewer, other diff connections) are never touched by it. The
 * per-path set exists only so `triggerRefresh(repoPath)` can reach every diff
 * subscription of a directory.
 */
interface DiffSubscription {
  callback: FileChangeCallback;
  manualRefreshTimer: ReturnType<typeof setTimeout> | null;
}

const diffSubscriptions = new Map<string, Set<DiffSubscription>>();

/**
 * Start watching a repository for file changes on behalf of one diff
 * connection. The watch itself is shared (see file-watch-service.ts); this
 * registers the diff worker's subscriber: paths are discarded, only
 * "something changed" is reported, debounced. Returns THIS subscription's own
 * unsubscribe (idempotent), which the connection calls on disconnect. There is
 * deliberately no path-keyed stop: it would silence every tab and session
 * watching the directory.
 *
 * @param repoPath - Path to the git repository
 * @param onChange - Callback when files change (debounced)
 */
export function startWatching(repoPath: string, onChange: FileChangeCallback): () => void {
  const log = logger.child({ repoPath });
  const subscription: DiffSubscription = { callback: onChange, manualRefreshTimer: null };
  const unsubscribeShared = subscribeToFileChanges(repoPath, {
    ignore: (relPath) => pathHasIgnoredSegment(relPath, fileWatchIgnorePatterns),
    debounceMs: DEBOUNCE_DELAY,
    maxWaitMs: null,
    maxPaths: 1,
    onChange: () => {
      log.debug('Triggering diff refresh after debounce');
      onChange();
    },
    onError: (reason) => {
      log.error({ reason }, 'File watcher error');
    },
  });
  const set = diffSubscriptions.get(repoPath) ?? new Set<DiffSubscription>();
  set.add(subscription);
  diffSubscriptions.set(repoPath, set);

  return () => {
    if (subscription.manualRefreshTimer) {
      clearTimeout(subscription.manualRefreshTimer);
      subscription.manualRefreshTimer = null;
    }
    unsubscribeShared();
    const current = diffSubscriptions.get(repoPath);
    if (current) {
      current.delete(subscription);
      if (current.size === 0) diffSubscriptions.delete(repoPath);
    }
  };
}

/**
 * Check if a repository is being watched.
 */
/**
 * Get specific lines from a file at a given ref.
 *
 * @param repoPath - Path to the git repository
 * @param filePath - Path to the file (relative to repo root)
 * @param startLine - Start line number (1-based, inclusive)
 * @param endLine - End line number (1-based, inclusive)
 * @param ref - 'working-dir' or a commit hash
 * @param requestUser - OS username to run git as. See {@link computeDefaultBaseSpec}.
 *   The 'working-dir' file is read as this user too (the worktree may be
 *   unreadable by the server process in multi-user mode).
 * @returns Array of line contents
 */
export async function getFileLines(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
  ref: GitDiffTarget,
  requestUser: string | null,
): Promise<string[]> {
  if (!isValidFilePath(filePath)) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  let content: string;
  if (ref === 'working-dir') {
    try {
      const read = await readWorkingTreeFile(repoPath, filePath, requestUser);
      if (read === null) throw new Error('file not found');
      if (read.kind === 'directory') throw new Error(`${filePath} is a directory`);
      content = read.content.toString('utf-8');
    } catch (error) {
      throw new Error(`Failed to read ${filePath} from working directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const result = await gitSafe(['show', `${ref}:${filePath}`], repoPath, requestUser);
    if (result === null) {
      throw new Error(`Failed to read ${filePath} at ref ${ref}`);
    }
    content = result;
  }

  const allLines = content.split('\n');
  // Clamp to actual file length (1-based inclusive)
  const clampedStart = Math.max(1, startLine);
  const clampedEnd = Math.min(allLines.length, endLine);

  if (clampedStart > clampedEnd) {
    return [];
  }

  return allLines.slice(clampedStart - 1, clampedEnd);
}

export function isWatching(repoPath: string): boolean {
  return (diffSubscriptions.get(repoPath)?.size ?? 0) > 0;
}

/**
 * Trigger a manual refresh for a watched repository.
 * Useful for testing or when a manual refresh is requested.
 *
 * @param repoPath - Path to the git repository
 */
export function triggerRefresh(repoPath: string): void {
  for (const subscription of diffSubscriptions.get(repoPath) ?? []) {
    // Clear existing timer and trigger with a short delay
    if (subscription.manualRefreshTimer) {
      clearTimeout(subscription.manualRefreshTimer);
    }
    subscription.manualRefreshTimer = setTimeout(() => {
      subscription.callback();
      subscription.manualRefreshTimer = null;
    }, MANUAL_REFRESH_DELAY);
  }
}
