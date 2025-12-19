/**
 * Git diff related types for GitDiffWorker
 */

/** File change status */
export type GitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked';

/** Stage state for display */
export type GitStageState =
  | 'committed'    // Already committed (after merge-base)
  | 'staged'       // Staged but not committed
  | 'unstaged'     // Working directory only
  | 'partial';     // Partially staged

/** Changed file info */
export interface GitDiffFile {
  path: string;
  status: GitFileStatus;
  stageState: GitStageState;
  oldPath?: string;          // For renamed/copied
  additions: number;
  deletions: number;
  isBinary: boolean;
}

/** Diff hunk */
export interface GitDiffHunk {
  header: string;            // e.g., @@ -1,5 +1,7 @@
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

/** Diff line */
export interface GitDiffLine {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/** Target reference for diff comparison */
export type GitDiffTarget = 'working-dir' | string;  // 'working-dir' or commit hash

/** Diff summary (sent via WebSocket) */
export interface GitDiffSummary {
  baseCommit: string;        // Comparison base commit hash
  targetRef: GitDiffTarget;  // Target: 'working-dir' or commit hash
  files: GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  updatedAt: string;         // ISO 8601
}

/** Full diff data (for rendering) */
export interface GitDiffData {
  summary: GitDiffSummary;
  rawDiff: string;           // Raw unified diff text
}

/** File diff detail (for individual file view) */
export interface GitDiffFileDetail {
  file: GitDiffFile;
  hunks: GitDiffHunk[];
  rawDiff: string;
}

// ============================================================
// WebSocket Messages for GitDiffWorker
// ============================================================

/**
 * Valid message types for GitDiffServerMessage.
 * Single source of truth for both type definitions and runtime validation.
 */
export const GIT_DIFF_SERVER_MESSAGE_TYPES = {
  'diff-data': 1,
  'diff-error': 2,
} as const;

export type GitDiffServerMessageType = keyof typeof GIT_DIFF_SERVER_MESSAGE_TYPES;

/** Server → Client messages */
export type GitDiffServerMessage =
  | { type: 'diff-data'; data: GitDiffData }
  | { type: 'diff-error'; error: string };

/** Client → Server messages */
export type GitDiffClientMessage =
  | { type: 'refresh' }
  | { type: 'set-base-commit'; ref: string }
  | { type: 'set-target-commit'; ref: GitDiffTarget };  // 'working-dir' or commit/branch ref
