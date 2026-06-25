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
import { MERGE_BASE_REF_PREFIX, DEFAULT_FORK_POINT_SPEC } from '@agent-console/shared';
import { readFile, stat } from 'fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join } from 'path';
import { createLogger } from '../lib/logger.js';
import { fileWatchIgnorePatterns } from '../lib/server-config.js';
import {
  runAsUser as defaultRunAsUser,
  shellEscape,
  type RunAsUserOpts,
  type RunAsUserResult,
} from './privilege-elevation.js';

const logger = createLogger('git-diff-service');

// ============================================================
// Privilege-elevation-aware git invocation
// ============================================================

/**
 * Issue #869: every git invocation in this service routes through
 * `runAsUser` so that, in multi-user mode, git runs as the worktree's owning
 * user rather than the server process user. Otherwise git refuses to operate
 * with "dubious ownership in repository at ...".
 *
 * `runAsUser` itself auto-bypasses elevation when `requestUser` is null/empty
 * or matches the server-process user, so the single-user path stays a plain
 * `sh -c 'git ...'` with no sudo overhead.
 */
type RunAsUserFn = (opts: RunAsUserOpts) => Promise<RunAsUserResult>;

let _runAsUser: RunAsUserFn = defaultRunAsUser;

/**
 * Inject a fake `runAsUser` implementation for tests. Pass `null` to restore
 * the real implementation. Tests should call this in `beforeEach` and reset in
 * `afterEach` to avoid cross-test leakage.
 *
 * @internal Test-only seam; production callers must not use this.
 */
export function __setRunAsUserForTesting(fn: RunAsUserFn | null): void {
  _runAsUser = fn ?? defaultRunAsUser;
}

/** Default timeout for git invocations in this service (mirrors lib/git.ts). */
const DEFAULT_GIT_TIMEOUT_MS = 30000;

interface RunGitOptions {
  /**
   * When true, return null on non-zero exit instead of throwing. Mirrors
   * `gitSafe()` semantics in `lib/git.ts`.
   */
  safe?: boolean;
  /**
   * Output trimming mode (default `'full'`):
   *   - `'full'`     → `stdout.trim()`, mirrors `git()`. Use for single-token
   *                    outputs like rev-parse / merge-base / symbolic-ref.
   *   - `'leading'`  → `stdout.trimStart()`, mirrors `gitRaw()`. Use for diff
   *                    output where trailing newlines are significant.
   *   - `'preserve'` → no trimming. Use for `git status --porcelain` and
   *                    similar formats whose every line has meaningful leading
   *                    whitespace (the staged/unstaged status columns).
   */
  trim?: 'full' | 'leading' | 'preserve';
  /** Override the default 30s timeout. */
  timeoutMs?: number;
}

/**
 * Run a `git` command in `repoPath` as `requestUser` (or as the server user
 * when elevation is not needed).
 *
 * Args are shell-escaped before being joined into the `sh -c` command string,
 * preventing injection from user-controlled refs / paths.
 *
 * Return shape mirrors `lib/git.ts`:
 *   - default     → throws on non-zero exit, returns trimmed stdout
 *   - opts.raw    → throws on non-zero exit, returns `stdout.trimStart()`
 *   - opts.safe   → returns null on non-zero exit, returns trimmed stdout otherwise
 */
async function runGit(
  args: string[],
  repoPath: string,
  requestUser: string | null,
  options: RunGitOptions = {},
): Promise<string | null> {
  const { safe = false, trim = 'full', timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = options;
  const command = ['git', ...args].map(shellEscape).join(' ');
  const { stdout, stderr, exitCode, timedOut } = await _runAsUser({
    username: requestUser,
    command,
    cwd: repoPath,
    timeoutMs,
  });
  if (exitCode !== 0) {
    if (safe) return null;
    const reason = timedOut
      ? `timed out after ${timeoutMs}ms`
      : stderr.trim() || `exit code ${exitCode}`;
    throw new Error(`git ${args[0] ?? '<unknown>'} failed: ${reason}`);
  }
  switch (trim) {
    case 'full':     return stdout.trim();
    case 'leading':  return stdout.trimStart();
    case 'preserve': return stdout;
  }
}

/** Throwing variant: returns stdout per `options.trim` (default `'full'`). */
async function runGitOrThrow(
  args: string[],
  repoPath: string,
  requestUser: string | null,
  options: Omit<RunGitOptions, 'safe'> = {},
): Promise<string> {
  const result = await runGit(args, repoPath, requestUser, options);
  // Non-safe variant never returns null.
  return result as string;
}

/** Safe variant: null on failure, never throws. Output is fully trimmed. */
async function runGitSafe(
  args: string[],
  repoPath: string,
  requestUser: string | null,
): Promise<string | null> {
  return runGit(args, repoPath, requestUser, { safe: true });
}

/** Check whether a git ref exists. */
async function checkRefExists(ref: string, repoPath: string, requestUser: string | null): Promise<boolean> {
  const result = await runGitSafe(['rev-parse', '--verify', ref], repoPath, requestUser);
  return result !== null;
}

/**
 * Resolve the repository's default branch name via origin/HEAD symbolic-ref,
 * with main / master as fallbacks. Returns null when none can be determined.
 * Mirrors `lib/git.ts:getDefaultBranch` but routed via the elevation-aware
 * runner.
 */
async function getDefaultBranchAsUser(repoPath: string, requestUser: string | null): Promise<string | null> {
  const symbolicRef = await runGitSafe(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath, requestUser);
  if (symbolicRef) {
    return symbolicRef.replace('refs/remotes/origin/', '');
  }
  if (await checkRefExists('main', repoPath, requestUser)) {
    return 'main';
  }
  if (await checkRefExists('master', repoPath, requestUser)) {
    return 'master';
  }
  return null;
}

/** `git merge-base ref1 ref2`, null on failure. */
async function getMergeBaseAsUser(
  ref1: string,
  ref2: string,
  repoPath: string,
  requestUser: string | null,
): Promise<string | null> {
  return runGitSafe(['merge-base', ref1, ref2], repoPath, requestUser);
}

/** `git diff baseRef [targetRef]`, preserves trailing newlines for hunk parsing. */
async function getDiffAsUser(
  baseRef: string,
  targetRef: string | undefined,
  repoPath: string,
  requestUser: string | null,
): Promise<string> {
  const args = targetRef ? ['diff', baseRef, targetRef] : ['diff', baseRef];
  return runGitOrThrow(args, repoPath, requestUser, { trim: 'leading' });
}

/** `git diff --numstat baseRef [targetRef]`. */
async function getDiffNumstatAsUser(
  baseRef: string,
  targetRef: string | undefined,
  repoPath: string,
  requestUser: string | null,
): Promise<string> {
  const args = targetRef ? ['diff', '--numstat', baseRef, targetRef] : ['diff', '--numstat', baseRef];
  return runGitOrThrow(args, repoPath, requestUser, { trim: 'leading' });
}

/**
 * `git status --porcelain -uall`. Output is returned UNTRIMMED — every line
 * has meaningful leading whitespace (the staged/unstaged status columns), so
 * `.trim()` would silently strip the indexStatus from the first line and the
 * line would fail the `XY filename` regex in `parseStatusPorcelain`.
 */
async function getStatusPorcelainAsUser(
  repoPath: string,
  requestUser: string | null,
): Promise<string> {
  return runGitOrThrow(['status', '--porcelain', '-uall'], repoPath, requestUser, { trim: 'preserve' });
}

/** `git ls-files --others --exclude-standard`, returns [] on failure. */
async function getUntrackedFilesAsUser(
  repoPath: string,
  requestUser: string | null,
): Promise<string[]> {
  try {
    const output = await runGitOrThrow(['ls-files', '--others', '--exclude-standard'], repoPath, requestUser);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

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
 */
async function getFirstCommit(repoPath: string, requestUser: string | null): Promise<string | null> {
  const result = await runGitSafe(['rev-list', '--max-parents=0', 'HEAD'], repoPath, requestUser);
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
  const defaultBranch = await getDefaultBranchAsUser(repoPath, requestUser);

  if (defaultBranch) {
    const originRef = `origin/${defaultBranch}`;
    if (await checkRefExists(originRef, repoPath, requestUser)) {
      const mergeBase = await getMergeBaseAsUser(originRef, 'HEAD', repoPath, requestUser);
      if (mergeBase) {
        return mergeBase;
      }
    }

    const localMergeBase = await getMergeBaseAsUser(defaultBranch, 'HEAD', repoPath, requestUser);
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
 * @param requestUser - OS username to run git as (null = no elevation)
 * @returns A base spec string (never null)
 */
export async function computeDefaultBaseSpec(repoPath: string, requestUser: string | null): Promise<string> {
  const defaultBranch = await getDefaultBranchAsUser(repoPath, requestUser);

  if (defaultBranch) {
    if (await checkRefExists(`origin/${defaultBranch}`, repoPath, requestUser)) {
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
 * @param requestUser - OS username to run git as (null = no elevation)
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
    return getMergeBaseAsUser(ref, 'HEAD', repoPath, requestUser);
  }

  // Branch name or explicit commit hash.
  return resolveRef(spec, repoPath, requestUser);
}

/**
 * Resolve a ref (branch name or commit hash) to its commit hash.
 *
 * @param ref - Branch name or commit hash
 * @param repoPath - Path to the git repository
 * @param requestUser - OS username to run git as (null = no elevation)
 * @returns Resolved commit hash, or null if invalid
 */
export async function resolveRef(
  ref: string,
  repoPath: string,
  requestUser: string | null,
): Promise<string | null> {
  return runGitSafe(['rev-parse', ref], repoPath, requestUser);
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
 * @param requestUser - OS username to run git as (null = no elevation)
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
    rawDiff = await getDiffAsUser(baseCommit, gitTargetRef, repoPath, requestUser);
  } catch (error) {
    logger.warn({ error, repoPath, baseCommit, targetRef: gitTargetRef }, 'Git diff failed, using empty diff');
    rawDiff = '';
  }

  // Get numstat for statistics
  let numstatOutput: string;
  try {
    numstatOutput = await getDiffNumstatAsUser(baseCommit, gitTargetRef, repoPath, requestUser);
  } catch (error) {
    logger.warn({ error, repoPath, baseCommit, targetRef: gitTargetRef }, 'Git diff numstat failed, using empty output');
    numstatOutput = '';
  }

  // Get status to understand staged/unstaged (only relevant when comparing to working-dir)
  let statusOutput: string;
  let untrackedFiles: string[];
  if (isWorkingDir) {
    try {
      statusOutput = await getStatusPorcelainAsUser(repoPath, requestUser);
    } catch (error) {
      logger.warn({ error, repoPath }, 'Git status porcelain failed, using empty output');
      statusOutput = '';
    }

    untrackedFiles = await getUntrackedFilesAsUser(repoPath, requestUser);
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
        const { diff, lineCount, isBinary } = await generateUntrackedFileDiff(path, repoPath);
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
 * Validate that a file path is safe and doesn't escape the repository directory.
 * Prevents path traversal attacks via malicious filePath parameter.
 */
function isValidFilePath(filePath: string): boolean {
  // Reject absolute paths (including Windows drive-absolute)
  if (isAbsolute(filePath)) {
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
 * @param requestUser - OS username to run git as (null = no elevation)
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
    const rawDiff = await runGitOrThrow(['diff', baseCommit, '--', filePath], repoPath, requestUser, { trim: 'leading' });

    if (rawDiff) {
      return rawDiff;
    }

    // File not found in regular diff - check if it's an untracked file
    const untrackedFiles = await getUntrackedFilesAsUser(repoPath, requestUser);
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
/**
 * Get specific lines from a file at a given ref.
 *
 * @param repoPath - Path to the git repository
 * @param filePath - Path to the file (relative to repo root)
 * @param startLine - Start line number (1-based, inclusive)
 * @param endLine - End line number (1-based, inclusive)
 * @param ref - 'working-dir' or a commit hash
 * @param requestUser - OS username to run git as (null = no elevation). Ignored
 *   for the 'working-dir' branch (direct filesystem read).
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
      const buffer = await readFile(join(repoPath, filePath));
      content = buffer.toString('utf-8');
    } catch (error) {
      throw new Error(`Failed to read ${filePath} from working directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const result = await runGitSafe(['show', `${ref}:${filePath}`], repoPath, requestUser);
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
