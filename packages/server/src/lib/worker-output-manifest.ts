/**
 * Sidecar manifest for a worker's segmented output archive.
 *
 * Each PTY worker's cumulative output stream is physically stored as:
 *   archived gzip segments (oldest) + live `.log` file + pending flush buffer (newest)
 *
 * The manifest (`<workerId>.segments.json`) records the absolute-offset anchor
 * (`liveBaseOffset`), the archived segment index, the worker's generation
 * identifier (`epoch`), and any in-flight cut (`pendingCut`) needed for crash
 * recovery. See docs/design/terminal-history-paging.md §4.2 / §4.3.
 *
 * All writes are durable: temp file written and fsync'd, renamed over the
 * target, then the containing directory fsync'd. This is atomic against both
 * process crash (rename atomicity) and power loss (fsync ordering).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('worker-output-manifest');

/** Current manifest schema version. */
export const MANIFEST_VERSION = 1;

/**
 * Metadata for one archived gzip segment. A segment covers the absolute byte
 * range `[startOffset, endOffset)` of the cumulative stream (uncompressed).
 */
export interface SegmentMeta {
  /** Monotonically increasing sequence number; never reused or backfilled. */
  seq: number;
  /** Absolute start offset (inclusive) of this segment's uncompressed bytes. */
  startOffset: number;
  /** Absolute end offset (exclusive) of this segment's uncompressed bytes. */
  endOffset: number;
  /** Uncompressed byte length (`endOffset - startOffset`). */
  bytes: number;
  /** Compressed (gzip) byte length on disk. */
  gzBytes: number;
  /** File name (relative to the session outputs dir), e.g. `w-abc.seg-0.log.gz`. */
  file: string;
}

/**
 * Records a cut that has been committed to the manifest but whose live-file
 * rewrite may not have completed. Both fields are required so crash recovery
 * can decide — by comparing the on-disk live-file size — whether the rewrite
 * ran, in either direction (see §4.3).
 */
export interface PendingCut {
  /** Byte length of the archived head slice removed from the live file. */
  bytes: number;
  /** Expected live-file size once the rewrite (step 3) completes. */
  expectedLiveSizeAfter: number;
}

/** The persisted per-worker output manifest. */
export interface WorkerOutputManifest {
  version: number;
  /** Incarnation creation timestamp in ms (generation identifier). */
  epoch: number;
  /** Absolute position of the live file's first byte. */
  liveBaseOffset: number;
  /** Next segment sequence number to allocate (monotonic across prunes). */
  nextSeq: number;
  /** In-flight cut needing recovery, or null. */
  pendingCut: PendingCut | null;
  /** Archived segments, ordered oldest-first. */
  segments: SegmentMeta[];
}

/**
 * Build a fresh manifest for a brand-new (or degraded/missing) incarnation.
 * `liveBaseOffset` starts at 0 — the live file's first byte is stream position 0.
 */
export function createInitialManifest(epoch: number): WorkerOutputManifest {
  return {
    version: MANIFEST_VERSION,
    epoch,
    liveBaseOffset: 0,
    nextSeq: 0,
    pendingCut: null,
    segments: [],
  };
}

/** The first absolute offset still reachable (rises once retention prunes). */
export function firstAvailableOffset(manifest: WorkerOutputManifest): number {
  return manifest.segments[0]?.startOffset ?? manifest.liveBaseOffset;
}

/** Absolute path of a worker's manifest sidecar. */
export function manifestPathFor(outputsDir: string, sessionId: string, workerId: string): string {
  return path.join(outputsDir, sessionId, `${workerId}.segments.json`);
}

/** Regex matching a segment file name and capturing its sequence number. */
export function segmentFileRegex(workerId: string): RegExp {
  // Escape regex metacharacters in the workerId (ids are slug-like but be safe).
  const escaped = workerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.seg-(\\d+)\\.log\\.gz$`);
}

/**
 * Read and parse a manifest. Returns null if the file is missing or unparsable
 * (the caller degrades to fresh-manifest semantics — never a hard failure).
 */
export async function readManifest(manifestPath: string): Promise<WorkerOutputManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.warn({ manifestPath, err: error }, 'Failed to read output manifest');
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidManifest(parsed)) {
      logger.warn({ manifestPath }, 'Output manifest failed validation; degrading to fresh manifest');
      return null;
    }
    return parsed;
  } catch (error) {
    logger.warn({ manifestPath, err: error }, 'Failed to parse output manifest; degrading to fresh manifest');
    return null;
  }
}

function isValidManifest(value: unknown): value is WorkerOutputManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  // Reject a missing / stale / future-incompatible schema version — a mismatch
  // degrades to a fresh manifest rather than being read under wrong assumptions.
  if (m.version !== MANIFEST_VERSION) return false;
  if (typeof m.epoch !== 'number' || !Number.isFinite(m.epoch)) return false;
  if (typeof m.liveBaseOffset !== 'number' || m.liveBaseOffset < 0) return false;
  if (typeof m.nextSeq !== 'number' || m.nextSeq < 0) return false;
  if (m.pendingCut !== null) {
    const pc = m.pendingCut as Record<string, unknown> | null;
    if (typeof pc !== 'object' || pc === null) return false;
    if (typeof pc.bytes !== 'number' || typeof pc.expectedLiveSizeAfter !== 'number') return false;
  }
  if (!Array.isArray(m.segments)) return false;
  for (const seg of m.segments) {
    if (typeof seg !== 'object' || seg === null) return false;
    const s = seg as Record<string, unknown>;
    if (
      typeof s.seq !== 'number' ||
      typeof s.startOffset !== 'number' ||
      typeof s.endOffset !== 'number' ||
      typeof s.bytes !== 'number' ||
      typeof s.gzBytes !== 'number' ||
      typeof s.file !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Durably write bytes to `filePath`: write a sibling temp file, fsync it,
 * atomically rename over the target, then fsync the containing directory.
 *
 * The temp fsync guarantees the data blocks are on disk before the rename; the
 * directory fsync guarantees the rename (the new dir entry) is on disk. Without
 * both, a rename can reach disk ahead of the data on power loss.
 */
export async function writeFileDurable(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;

  const fh = await fs.open(tmpPath, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }

  await fs.rename(tmpPath, filePath);
  await fsyncDir(dir);
}

/**
 * fsync a directory so a preceding rename is durable. Non-fatal on platforms
 * that reject opening a directory for sync — the rename is still crash-atomic;
 * only power-loss ordering is at stake, and logging keeps the failure visible.
 */
async function fsyncDir(dir: string): Promise<void> {
  let dh: fs.FileHandle | null = null;
  try {
    dh = await fs.open(dir, 'r');
    await dh.sync();
  } catch (error) {
    logger.debug({ dir, err: error }, 'Directory fsync skipped (unsupported on this platform)');
  } finally {
    if (dh) {
      await dh.close().catch(() => {});
    }
  }
}

/** Durably write a manifest (temp + fsync + rename + dir fsync). */
export async function writeManifestDurable(manifestPath: string, manifest: WorkerOutputManifest): Promise<void> {
  await writeFileDurable(manifestPath, JSON.stringify(manifest));
}
