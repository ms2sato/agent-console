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

/** A chunk of expanded context lines for DiffViewer */
export interface ExpandedLineChunk {
  startLine: number;
  lines: string[];
}

// ============================================================
// Review Annotations
// ============================================================

/** A single review annotation marking a section of code that needs review */
export interface ReviewAnnotation {
  file: string;        // File path as shown in the diff
  startLine: number;   // Start line in the NEW file (1-based, inclusive)
  endLine: number;     // End line in the NEW file (1-based, inclusive)
  reason: string;      // Why this section needs review
}

/** Summary statistics for a review annotation set */
export interface AnnotationSummary {
  totalFiles: number;
  reviewFiles: number;
  mechanicalFiles: number;
  confidence: 'high' | 'medium' | 'low';
}

/** Review status for review queue items */
export type ReviewStatus = 'pending' | 'completed';

/** An inline comment from the reviewer */
export interface ReviewComment {
  id: string;
  file: string;
  line: number;
  body: string;
  createdAt: string;  // ISO timestamp
}

/** Complete set of annotations for a worker */
export interface ReviewAnnotationSet {
  workerId: string;
  annotations: ReviewAnnotation[];
  summary: AnnotationSummary;
  createdAt: string;  // ISO timestamp
  /** Session that requested the review (e.g., orchestrator). When absent, not a review queue item. */
  sourceSessionId?: string;
  /** Review lifecycle state. Defaults to 'pending' when sourceSessionId is provided. */
  status: ReviewStatus;
  /** Inline comments from the reviewer */
  comments: ReviewComment[];
}

/** Input for creating annotations (no workerId or createdAt - those are added by the service) */
export interface ReviewAnnotationInput {
  annotations: ReviewAnnotation[];
  summary: AnnotationSummary;
}

// ============================================================
// Review Queue API Types
// ============================================================

/** A single item in the review queue */
export interface ReviewQueueItem {
  workerId: string;
  sessionId: string;
  sessionTitle: string;
  sourceSessionId: string;
  sourceSessionTitle: string;
  parentSessionId?: string;
  parentSessionTitle?: string;
  annotationCount: number;
  summary: AnnotationSummary;
  status: ReviewStatus;
  commentCount: number;
  createdAt: string;
}

/** Review queue items grouped by source session */
export interface ReviewQueueGroup {
  sourceSessionId: string;
  sourceSessionTitle: string;
  items: ReviewQueueItem[];
}

// ============================================================
// Constants
// ============================================================

/**
 * Prefix for merge-base ref resolution in set-base-commit messages.
 * When the client sends a ref starting with this prefix (e.g., "merge-base:main"),
 * the server resolves it via `git merge-base <branch> HEAD` instead of `git rev-parse`.
 */
export const MERGE_BASE_REF_PREFIX = 'merge-base:';

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
  'file-lines': 3,
  'annotations-updated': 4,
} as const;

export type GitDiffServerMessageType = keyof typeof GIT_DIFF_SERVER_MESSAGE_TYPES;

/** Server → Client messages */
export type GitDiffServerMessage =
  | { type: 'diff-data'; data: GitDiffData }
  | { type: 'diff-error'; error: string }
  | { type: 'file-lines'; path: string; startLine: number; lines: string[] }
  | { type: 'annotations-updated'; annotations: ReviewAnnotationSet | null };

/** Client → Server messages */
export type GitDiffClientMessage =
  | { type: 'refresh' }
  | { type: 'set-base-commit'; ref: string }
  | { type: 'set-target-commit'; ref: GitDiffTarget }  // 'working-dir' or commit/branch ref
  | { type: 'get-file-lines'; path: string; startLine: number; endLine: number; ref: GitDiffTarget }
  | { type: 'get-annotations' };
