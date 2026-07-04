/**
 * File-based output persistence for terminal workers.
 *
 * The worker's cumulative output stream is stored as archived gzip segments
 * (oldest) + a live `.log` file + the pending flush buffer (newest). All wire
 * offsets are **absolute** — the byte position in the cumulative stream since
 * worker creation (or last restart); archival never rebases them. A per-worker
 * manifest sidecar (worker-output-manifest.ts) records the `liveBaseOffset`
 * anchor, the segment index, the generation `epoch`, and crash-recovery state.
 *
 * See docs/design/terminal-history-paging.md §3 / §4.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { gunzipSync } from 'bun';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { SessionDataPathResolver } from './session-data-path-resolver.js';
import { serverConfig } from './server-config.js';
import { createLogger } from './logger.js';
import {
  type WorkerOutputManifest,
  type SegmentMeta,
  createInitialManifest,
  readManifest,
  writeManifestDurable,
  writeFileDurable,
  manifestPathFor,
  segmentFileRegex,
  firstAvailableOffset,
} from './worker-output-manifest.js';

const logger = createLogger('worker-output-file');

/** Async gzip / gunzip (never the sync variants — the backend async-over-sync rule). */
const gzipAsync = promisify(gzipCb);
const gunzipAsync = promisify(gunzipCb);

/** TTL for a decompressed segment held in the per-worker range-read cache (§5.2). */
const SEGMENT_CACHE_TTL_MS = 30_000;

/** Best-effort newline-alignment scan window for a clamped range start (§5.2). */
const NEWLINE_ALIGN_SCAN_BYTES = 4096;

/**
 * Result of reading history. Offsets are absolute stream positions.
 */
export interface HistoryReadResult {
  /** The output data read from the stream. */
  data: string;
  /** Absolute end offset of the returned window (== total stream length seen). */
  offset: number;
  /** Absolute start offset of the first byte of `data`. */
  startOffset: number;
  /** Generation identifier of the incarnation that produced this data. */
  epoch: number;
}

/**
 * Result of a backwards range read (§5.1). `data` covers the absolute byte
 * range `[startOffset, endOffset)`; `endOffset <= beforeOffset`.
 */
export interface HistoryRangeResult {
  /** Output bytes covering `[startOffset, endOffset)`. Empty when unavailable. */
  data: string;
  /** Absolute start offset of `data`. */
  startOffset: number;
  /** Absolute end offset of `data` (exclusive); `<= beforeOffset`. */
  endOffset: number;
  /** True when older reachable history exists (`startOffset > firstAvailableOffset`). */
  hasMore: boolean;
  /** Generation identifier captured under the per-worker lock. */
  epoch: number;
}

/**
 * A single decompressed segment held per worker (§5.2). The promise is installed
 * BEFORE inflation begins so concurrent readers of the same `seq` share one
 * gunzip; a caller captures the entry, checks `seq`, and uses only its own
 * captured promise result — never re-reading the slot after an `await`.
 */
interface DecompressedSegmentEntry {
  seq: number;
  promise: Promise<Buffer>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Pending flush info for a worker.
 */
interface PendingFlush {
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  resolver: SessionDataPathResolver;
  /**
   * The worker object's epoch, forwarded so a flush that has to lazily create
   * the manifest (e.g. after an initialize I/O failure) records the SAME epoch
   * the live `output` stream is tagged with, rather than minting a divergent one.
   */
  epochHint?: number;
}

/**
 * Configuration for WorkerOutputFileManager.
 * Allows overriding defaults for testing without module-level mocking.
 */
export interface WorkerOutputFileConfig {
  flushThreshold: number;
  flushInterval: number;
  fileMaxSize: number;
  /** Max archived segments retained per worker; 0 = unlimited. */
  maxSegments: number;
  /** Server-side cap on bytes served in one `history-range` response (§5.2). */
  rangeMaxBytes: number;
}

/**
 * Manages file-based output persistence for workers.
 * Uses buffering to reduce file I/O frequency.
 */
export class WorkerOutputFileManager {
  /** Pending buffers waiting to be flushed: sessionId/workerId -> PendingFlush */
  private pendingFlushes = new Map<string, PendingFlush>();

  /**
   * Per-worker serialization domain. A single promise-chain per worker covers
   * append/flush, the segmented cut, and reset/delete so no append lands
   * mid-cut and no reader observes an intermediate cut state (§4.3). (Range
   * reads join this domain in PR-B.)
   */
  private locks = new Map<string, Promise<unknown>>();

  /** Workers whose lazy crash-recovery + orphan scan has already run this process. */
  private recovered = new Set<string>();

  /**
   * Per-worker single-entry decompressed-segment cache for range reads (§5.2).
   * Keyed by `sessionId/workerId`; each slot holds the promise of one inflated
   * segment, dropped on a 30s TTL and invalidated on prune / reset / delete.
   */
  private segmentCache = new Map<string, DecompressedSegmentEntry>();

  private readonly config: WorkerOutputFileConfig;

  constructor(config?: Partial<WorkerOutputFileConfig>) {
    this.config = {
      flushThreshold: config?.flushThreshold ?? serverConfig.WORKER_OUTPUT_FLUSH_THRESHOLD,
      flushInterval: config?.flushInterval ?? serverConfig.WORKER_OUTPUT_FLUSH_INTERVAL,
      fileMaxSize: config?.fileMaxSize ?? serverConfig.WORKER_OUTPUT_FILE_MAX_SIZE,
      maxSegments: config?.maxSegments ?? serverConfig.WORKER_OUTPUT_MAX_SEGMENTS,
      rangeMaxBytes: config?.rangeMaxBytes ?? serverConfig.WORKER_OUTPUT_RANGE_MAX_BYTES,
    };
  }

  // ========== Serialization domain ==========

  /**
   * Run `fn` exclusively within the per-worker serialization domain. Calls for
   * the same key run in submission order; the chain never rejects (each link is
   * isolated) so one failing operation cannot wedge subsequent ones.
   */
  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // Tail marker that always resolves, so the next link runs regardless of
    // this link's outcome. Prune the map when this is still the tail.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    });
    return result;
  }

  // ========== Path helpers ==========

  /**
   * Get the output file path for a worker.
   */
  getOutputFilePath(sessionId: string, workerId: string, resolver: SessionDataPathResolver): string {
    return resolver.getOutputFilePath(sessionId, workerId);
  }

  private getManifestPath(sessionId: string, workerId: string, resolver: SessionDataPathResolver): string {
    return manifestPathFor(resolver.getOutputsDir(), sessionId, workerId);
  }

  private getWorkerDir(sessionId: string, resolver: SessionDataPathResolver): string {
    return path.join(resolver.getOutputsDir(), sessionId);
  }

  /**
   * Check if a file exists at the given path.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the actual file path for a worker, checking for legacy compressed files.
   * Returns { path, isCompressed } where isCompressed indicates the file format.
   * Returns null if no file exists.
   *
   * Note: Legacy .log.gz files are still supported for reading (hibernation-era
   * migration compatibility); they are the whole stream at base offset 0.
   */
  private async getActualFilePath(sessionId: string, workerId: string, resolver: SessionDataPathResolver): Promise<{ path: string; isCompressed: boolean } | null> {
    const outputsDir = resolver.getOutputsDir();
    const uncompressedPath = path.join(outputsDir, sessionId, `${workerId}.log`);
    const compressedPath = path.join(outputsDir, sessionId, `${workerId}.log.gz`);

    // Check uncompressed file first (current format)
    if (await this.fileExists(uncompressedPath)) {
      return { path: uncompressedPath, isCompressed: false };
    }

    // Check legacy compressed file
    if (await this.fileExists(compressedPath)) {
      return { path: compressedPath, isCompressed: true };
    }

    return null;
  }

  /**
   * Get the key for tracking pending flushes.
   */
  private getKey(sessionId: string, workerId: string): string {
    return `${sessionId}/${workerId}`;
  }

  // ========== Manifest / recovery ==========

  /** Mint a fresh generation identifier from the current wall clock. */
  private mintEpoch(): number {
    return Date.now();
  }

  /**
   * Load the manifest, lazily creating it (fresh epoch, base 0) if missing and
   * running crash recovery + orphan cleanup on first access. MUST be called
   * inside the worker's serialization domain.
   */
  private async loadManifestWithRecovery(
    sessionId: string,
    workerId: string,
    resolver: SessionDataPathResolver,
    epochHint?: number,
  ): Promise<WorkerOutputManifest> {
    const key = this.getKey(sessionId, workerId);
    const manifestPath = this.getManifestPath(sessionId, workerId, resolver);
    const dir = this.getWorkerDir(sessionId, resolver);
    const filePath = this.getOutputFilePath(sessionId, workerId, resolver);

    let manifest = await readManifest(manifestPath);

    // Pending-cut recovery must run on EVERY load where a cut is in flight, not
    // just the first access this process. A cut that fails mid-way (cutSegment
    // throws between step 2 and step 3, swallowed by flushLocked's try/catch)
    // must be repaired on the next access even though `recovered` is already
    // set — otherwise the un-cut head double-counts offsets forever.
    if (manifest !== null && manifest.pendingCut !== null) {
      manifest = await this.recoverPendingCut(manifest, manifestPath, filePath);
    }

    if (!this.recovered.has(key)) {
      if (manifest === null) {
        // Missing/unparsable manifest — create a fresh one. The epoch hint (the
        // worker object's already-minted epoch) is used when present so the
        // manifest and the in-memory worker agree; otherwise degrade to a fresh
        // mint. Any legacy `.log` / `.log.gz` present is the whole stream at base 0.
        manifest = createInitialManifest(epochHint ?? this.mintEpoch());
        await fs.mkdir(dir, { recursive: true });
        await writeManifestDurable(manifestPath, manifest);
      } else {
        // Orphan-scan is the expensive part; keep it gated to first access.
        await this.cleanupOrphanSegments(dir, workerId, manifest);
      }
      this.recovered.add(key);
    } else if (manifest === null) {
      manifest = createInitialManifest(epochHint ?? this.mintEpoch());
      await fs.mkdir(dir, { recursive: true });
      await writeManifestDurable(manifestPath, manifest);
    }

    return manifest;
  }

  /**
   * Finish an interrupted cut. Decides — by the on-disk live-file size — whether
   * the live-file rewrite (step 3) already ran, in either direction (§4.3).
   */
  private async recoverPendingCut(
    manifest: WorkerOutputManifest,
    manifestPath: string,
    filePath: string,
  ): Promise<WorkerOutputManifest> {
    const pendingCut = manifest.pendingCut;
    if (pendingCut === null) return manifest;

    let liveSize = 0;
    try {
      liveSize = (await fs.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      liveSize = 0;
    }

    if (liveSize === pendingCut.expectedLiveSizeAfter) {
      // Step 3 already completed; just finalize (step 4).
      logger.info({ filePath, liveSize }, 'Recovered cut: live-file rewrite already applied, finalizing');
    } else if (liveSize === pendingCut.expectedLiveSizeAfter + pendingCut.bytes) {
      // Step 3 did not run; redo it (drop the duplicated head).
      const buffer = await fs.readFile(filePath);
      const remainder = buffer.subarray(pendingCut.bytes);
      await writeFileDurable(filePath, remainder);
      logger.info({ filePath, cutBytes: pendingCut.bytes }, 'Recovered cut: re-applied live-file rewrite');
    } else {
      // Ambiguous (should not happen with the serialization domain). Accept the
      // current live file and clear the pending marker rather than corrupt data.
      logger.warn(
        { filePath, liveSize, expectedLiveSizeAfter: pendingCut.expectedLiveSizeAfter, cutBytes: pendingCut.bytes },
        'Recovered cut: unexpected live-file size, clearing pendingCut without rewrite',
      );
    }

    manifest.pendingCut = null;
    await writeManifestDurable(manifestPath, manifest);
    return manifest;
  }

  /**
   * Delete segment files not referenced by the manifest (orphans left by a
   * crash between the segment write (step 1) and the manifest write (step 2)).
   */
  private async cleanupOrphanSegments(dir: string, workerId: string, manifest: WorkerOutputManifest): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const referenced = new Set(manifest.segments.map((s) => s.file));
    const re = segmentFileRegex(workerId);
    for (const entry of entries) {
      if (re.test(entry) && !referenced.has(entry)) {
        await fs.unlink(path.join(dir, entry)).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn({ dir, entry, err }, 'Failed to delete orphan segment file');
          }
        });
        logger.info({ dir, entry }, 'Deleted orphan segment file');
      }
    }
  }

  /**
   * Read the live file, decompressing a legacy `.log.gz` if that is the only
   * form present. Returns an empty buffer when no live file exists.
   */
  private async readLiveBuffer(sessionId: string, workerId: string, resolver: SessionDataPathResolver): Promise<Buffer> {
    const actualFile = await this.getActualFilePath(sessionId, workerId, resolver);
    if (!actualFile) return Buffer.alloc(0);
    const rawBuffer = await fs.readFile(actualFile.path);
    return actualFile.isCompressed ? Buffer.from(gunzipSync(rawBuffer)) : rawBuffer;
  }

  // ========== Initialization ==========

  /**
   * Initialize an empty output file + manifest for a worker.
   * Call this immediately when creating a new worker so the history file and
   * generation epoch exist before any WebSocket connects.
   *
   * @param epoch the worker object's already-minted epoch; recorded in the
   *   manifest for a brand-new worker so history reads and live `output`
   *   messages carry the same generation identifier. Ignored when a manifest
   *   already exists (server restart — the persisted epoch wins).
   * @returns the effective epoch recorded in the manifest.
   */
  async initializeWorkerOutput(sessionId: string, workerId: string, resolver: SessionDataPathResolver, epoch?: number): Promise<number> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, async () => {
      const filePath = this.getOutputFilePath(sessionId, workerId, resolver);
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // Ensure a manifest exists (records `epoch` for a brand-new worker).
        const manifest = await this.loadManifestWithRecovery(sessionId, workerId, resolver, epoch);

        // Create empty live file if none exists yet (race-avoidance for early WS connect).
        const actualFile = await this.getActualFilePath(sessionId, workerId, resolver);
        if (!actualFile) {
          await fs.writeFile(filePath, '', 'utf-8');
        }

        logger.debug({ sessionId, workerId, filePath, epoch: manifest.epoch }, 'Initialized worker output file + manifest');
        return manifest.epoch;
      } catch (error) {
        logger.error({ sessionId, workerId, err: error }, 'Failed to initialize worker output file');
        // Best-effort: ensure the epoch is persisted so a later history read
        // (which cannot see the worker object's epoch) does not lazily mint a
        // DIFFERENT one and diverge from the live `output` stream. Never
        // overwrite an existing manifest (that would drop segment references).
        const manifestPath = this.getManifestPath(sessionId, workerId, resolver);
        try {
          const existing = await readManifest(manifestPath);
          if (existing) return existing.epoch;
          const fresh = createInitialManifest(epoch ?? this.mintEpoch());
          await fs.mkdir(path.dirname(manifestPath), { recursive: true });
          await writeManifestDurable(manifestPath, fresh);
          this.recovered.add(key);
          return fresh.epoch;
        } catch {
          // Truly degraded I/O — reads will mint their own epoch; nothing more
          // we can do here without a working filesystem.
          return epoch ?? this.mintEpoch();
        }
      }
    });
  }

  /**
   * Get the current generation epoch for a worker, lazily creating the manifest
   * (and epoch) if missing. Used to tag the in-memory worker object at activation.
   *
   * @param epochHint the worker object's epoch; used only if the manifest has to
   *   be created (missing), so a lazily-minted epoch matches the in-memory
   *   worker rather than diverging from it. Ignored when the manifest exists.
   */
  async getEpoch(sessionId: string, workerId: string, resolver: SessionDataPathResolver, epochHint?: number): Promise<number> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, async () => {
      const manifest = await this.loadManifestWithRecovery(sessionId, workerId, resolver, epochHint);
      return manifest.epoch;
    });
  }

  // ========== Append / flush / cut ==========

  /**
   * Buffer output data for periodic flushing to file.
   * Flushes immediately if buffer exceeds threshold.
   */
  bufferOutput(sessionId: string, workerId: string, data: string, resolver: SessionDataPathResolver, epochHint?: number): void {
    const key = this.getKey(sessionId, workerId);
    let pending = this.pendingFlushes.get(key);

    if (!pending) {
      pending = { buffer: '', timer: null, resolver, epochHint };
      this.pendingFlushes.set(key, pending);
    } else if (epochHint !== undefined) {
      pending.epochHint = epochHint;
    }

    pending.buffer += data;

    // Flush immediately if buffer exceeds threshold
    if (pending.buffer.length >= this.config.flushThreshold) {
      void this.flushBuffer(sessionId, workerId).catch((err) => {
        logger.error({ sessionId, workerId, err }, 'Failed to flush buffer on threshold');
      });
      return;
    }

    // Schedule flush if not already scheduled
    if (!pending.timer) {
      pending.timer = setTimeout(() => {
        void this.flushBuffer(sessionId, workerId).catch((err) => {
          logger.error({ sessionId, workerId, err }, 'Failed to flush buffer on timer');
        });
      }, this.config.flushInterval);
    }
  }

  /**
   * Flush buffered output to file (public entry — acquires the lock).
   * The size threshold triggers an archive cut when the live file overflows.
   */
  private async flushBuffer(sessionId: string, workerId: string): Promise<void> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, () => this.flushLocked(sessionId, workerId));
  }

  /**
   * Flush the pending buffer. MUST be called inside the serialization domain.
   * Legacy `.log.gz` files are migrated to `.log` on first write.
   */
  private async flushLocked(sessionId: string, workerId: string): Promise<void> {
    const key = this.getKey(sessionId, workerId);
    const pending = this.pendingFlushes.get(key);

    if (!pending || pending.buffer.length === 0) {
      return;
    }

    // Clear timer and take buffer content
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const dataToWrite = pending.buffer;
    pending.buffer = '';

    const resolver = pending.resolver;
    const filePath = this.getOutputFilePath(sessionId, workerId, resolver);

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Ensure recovery has run and the manifest is loaded (needed for cut base).
      // Forward the worker's epoch so that if this flush is the first op to
      // create the manifest (initialize I/O failed earlier), it records the same
      // epoch the live `output` stream carries instead of minting a divergent one.
      const manifest = await this.loadManifestWithRecovery(sessionId, workerId, resolver, pending.epochHint);

      const actualFile = await this.getActualFilePath(sessionId, workerId, resolver);
      if (actualFile?.isCompressed) {
        // Migrate from legacy compressed to uncompressed. Its content is the
        // start of the stream, so liveBaseOffset stays 0.
        const rawBuffer = await fs.readFile(actualFile.path);
        const decompressed = gunzipSync(rawBuffer);
        const existingContent = new TextDecoder('utf-8').decode(decompressed);
        await fs.writeFile(filePath, existingContent + dataToWrite, 'utf-8');
        await fs.unlink(actualFile.path).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn({ sessionId, workerId, path: actualFile.path, err }, 'Failed to delete legacy compressed file during migration');
          }
        });
      } else {
        // Simple append to the live file (hot path — append is not fsync'd).
        await fs.appendFile(filePath, dataToWrite, 'utf-8');
      }

      const stats = await fs.stat(filePath);
      if (stats.size > this.config.fileMaxSize) {
        await this.cutSegment(sessionId, workerId, resolver, manifest);
      }
    } catch (error) {
      logger.error({ sessionId, workerId, err: error }, 'Failed to flush output to file');
    }
  }

  /**
   * Archive the oldest ~20% of the live file into a gzip segment and rewrite the
   * live file to the remainder. Two-phase and crash-safe (§4.1 / §4.3). MUST be
   * called inside the serialization domain (via flushLocked).
   */
  private async cutSegment(
    sessionId: string,
    workerId: string,
    resolver: SessionDataPathResolver,
    manifest: WorkerOutputManifest,
  ): Promise<void> {
    const filePath = this.getOutputFilePath(sessionId, workerId, resolver);
    const dir = this.getWorkerDir(sessionId, resolver);
    const manifestPath = this.getManifestPath(sessionId, workerId, resolver);

    const buffer = await fs.readFile(filePath);
    const currentSize = buffer.length;
    const targetSize = Math.floor(this.config.fileMaxSize * 0.8);

    let slicePoint = currentSize - targetSize;
    if (slicePoint <= 0) {
      // Nothing meaningful to archive (target >= current). Skip.
      return;
    }
    // Advance to a UTF-8 character boundary (skip continuation bytes 0x80-0xBF).
    while (slicePoint < buffer.length && (buffer[slicePoint] & 0xc0) === 0x80) {
      slicePoint++;
    }

    const headSlice = buffer.subarray(0, slicePoint);
    const remainder = buffer.subarray(slicePoint);
    const cutBytes = headSlice.length;

    const seq = manifest.nextSeq;
    const segFileName = `${workerId}.seg-${seq}.log.gz`;
    const segPath = path.join(dir, segFileName);

    const gz = await gzipAsync(headSlice);

    // Step 1: durably write the segment file.
    await writeFileDurable(segPath, gz);

    // Step 2: commit the manifest with the segment appended, base advanced, and
    // the pendingCut marker set.
    const newSeg: SegmentMeta = {
      seq,
      startOffset: manifest.liveBaseOffset,
      endOffset: manifest.liveBaseOffset + cutBytes,
      bytes: cutBytes,
      gzBytes: gz.length,
      file: segFileName,
    };
    manifest.segments.push(newSeg);
    manifest.liveBaseOffset = newSeg.endOffset;
    manifest.nextSeq = seq + 1;
    manifest.pendingCut = { bytes: cutBytes, expectedLiveSizeAfter: remainder.length };
    await writeManifestDurable(manifestPath, manifest);

    // Step 3: durably rewrite the live file to the remainder.
    await writeFileDurable(filePath, remainder);

    // Step 4: finalize. Splice the over-cap segments out of the manifest
    // in-memory, clear pendingCut, and COMMIT the manifest BEFORE deleting the
    // pruned files — durable-write-before-destroy. A crash after this write
    // leaves the pruned files as orphans (not referenced by the manifest),
    // which cleanupOrphanSegments sweeps on the next process start; the inverse
    // order would leave the manifest referencing already-deleted files.
    const prunable = this.selectPrunableSegments(manifest);
    manifest.pendingCut = null;
    await writeManifestDurable(manifestPath, manifest);
    await this.deleteSegmentFiles(dir, prunable);
    if (prunable.length > 0) {
      // A pruned segment may be the one held in the range-read cache; drop it so
      // no reader is served bytes for a now-unavailable range.
      this.invalidateSegmentCache(this.getKey(sessionId, workerId));
    }

    logger.debug(
      { sessionId, workerId, seq, cutBytes, liveBaseOffset: manifest.liveBaseOffset, segments: manifest.segments.length },
      'Archived output segment',
    );
  }

  /**
   * Enforce the retention cap by removing the oldest segment entries from the
   * manifest IN-MEMORY (splice) and returning them so the caller can delete
   * their files AFTER the pruned manifest is durably committed.
   * `maxSegments === 0` opts into unlimited retention.
   */
  private selectPrunableSegments(manifest: WorkerOutputManifest): SegmentMeta[] {
    const cap = this.config.maxSegments;
    if (cap <= 0 || manifest.segments.length <= cap) return [];
    const removeCount = manifest.segments.length - cap;
    return manifest.segments.splice(0, removeCount);
  }

  /** Delete segment files (ENOENT-tolerant). */
  private async deleteSegmentFiles(dir: string, segments: SegmentMeta[]): Promise<void> {
    for (const seg of segments) {
      await fs.unlink(path.join(dir, seg.file)).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ dir, file: seg.file, err }, 'Failed to delete pruned segment file');
        }
      });
    }
    if (segments.length > 0) {
      logger.debug({ dir, removed: segments.length }, 'Pruned oldest output segments');
    }
  }

  // ========== Reads ==========

  /**
   * Read output history from an absolute `fromOffset`.
   *
   * Serving rules (§3.1), where `base = liveBaseOffset` and
   * `total = base + fileSize + pendingByteLength`:
   * - `fromOffset` within `[base, total)`: incremental live-window continuation.
   * - `fromOffset < base` (window scrolled into the archive): return the recent
   *   window (last N lines) with an honest `startOffset > fromOffset`.
   * - `fromOffset > total` (stale / diverged, e.g. across a restart): return the
   *   recent window, which lies entirely below the request (`startOffset < fromOffset`).
   *
   * @param recentWindowLines line cap for the recent-window fallback branches.
   */
  async readHistoryWithOffset(
    sessionId: string,
    workerId: string,
    resolver: SessionDataPathResolver,
    fromOffset?: number,
    recentWindowLines?: number,
  ): Promise<HistoryReadResult> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, async () => {
      try {
        const manifest = await this.loadManifestWithRecovery(sessionId, workerId, resolver);
        const base = manifest.liveBaseOffset;
        const epoch = manifest.epoch;

        const pending = this.pendingFlushes.get(key);
        const pendingBuffer = pending?.buffer || '';
        const pendingByteLength = Buffer.byteLength(pendingBuffer, 'utf-8');

        const liveBuffer = await this.readLiveBuffer(sessionId, workerId, resolver);
        const fileSize = liveBuffer.length;
        const total = base + fileSize + pendingByteLength;

        // Initial load (fromOffset absent or 0): full live window + pending.
        if (fromOffset === undefined || fromOffset <= 0) {
          const data = liveBuffer.toString('utf-8') + pendingBuffer;
          return { data, offset: total, startOffset: base, epoch };
        }

        if (fromOffset < base || fromOffset > total) {
          // Archived-out or stale/diverged — return the recent window.
          return this.buildRecentWindow(liveBuffer, pendingBuffer, total, recentWindowLines, epoch);
        }

        if (fromOffset === total) {
          return { data: '', offset: total, startOffset: total, epoch };
        }

        // base <= fromOffset < total — incremental continuation.
        const relOffset = fromOffset - base;
        if (relOffset >= fileSize) {
          // Within the pending buffer.
          const pendingSkip = relOffset - fileSize;
          const remainingPending = Buffer.from(pendingBuffer, 'utf-8').subarray(pendingSkip);
          return { data: remainingPending.toString('utf-8'), offset: total, startOffset: fromOffset, epoch };
        }

        const data = liveBuffer.subarray(relOffset).toString('utf-8') + pendingBuffer;
        return { data, offset: total, startOffset: fromOffset, epoch };
      } catch (error) {
        logger.error({ sessionId, workerId, err: error }, 'Failed to read output file');
        return { data: '', offset: 0, startOffset: 0, epoch: 0 };
      }
    });
  }

  /**
   * Read the last N lines of the live window (initial-load shape). Offsets absolute.
   */
  async readLastNLines(
    sessionId: string,
    workerId: string,
    maxLines: number,
    resolver: SessionDataPathResolver,
  ): Promise<HistoryReadResult> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, async () => {
      try {
        const manifest = await this.loadManifestWithRecovery(sessionId, workerId, resolver);
        const base = manifest.liveBaseOffset;
        const epoch = manifest.epoch;

        const pending = this.pendingFlushes.get(key);
        const pendingBuffer = pending?.buffer || '';
        const pendingByteLength = Buffer.byteLength(pendingBuffer, 'utf-8');

        const liveBuffer = await this.readLiveBuffer(sessionId, workerId, resolver);
        const fileSize = liveBuffer.length;
        const total = base + fileSize + pendingByteLength;

        return this.buildRecentWindow(liveBuffer, pendingBuffer, total, maxLines, epoch);
      } catch (error) {
        logger.error({ sessionId, workerId, err: error }, 'Failed to read output file for last N lines');
        return { data: '', offset: 0, startOffset: 0, epoch: 0 };
      }
    });
  }

  /**
   * Build the recent-window result: the last `maxLines` lines of the live
   * window (live file + pending buffer). `startOffset` is derived from the byte
   * length of the returned data so it is an honest absolute position.
   */
  private buildRecentWindow(
    liveBuffer: Buffer,
    pendingBuffer: string,
    total: number,
    maxLines: number | undefined,
    epoch: number,
  ): HistoryReadResult {
    const fullContent = liveBuffer.toString('utf-8') + pendingBuffer;
    const data = maxLines === undefined ? fullContent : this.getLastNLines(fullContent, maxLines);
    const startOffset = total - Buffer.byteLength(data, 'utf-8');
    return { data, offset: total, startOffset, epoch };
  }

  /**
   * Get the last N lines from a string.
   * Handles both \n and \r\n line endings.
   * Empty lines are preserved in the count.
   */
  private getLastNLines(content: string, maxLines: number): string {
    if (maxLines <= 0) {
      return '';
    }

    // Split by newlines, handling both \n and \r\n
    const lines = content.split(/(\r?\n)/);

    // Count actual lines (content elements at even indices)
    let lineCount = 0;
    for (let i = 0; i < lines.length; i += 2) {
      lineCount++;
    }

    if (lineCount <= maxLines) {
      return content;
    }

    const linesToSkip = lineCount - maxLines;

    let currentLine = 0;
    let startIndex = 0;

    for (let i = 0; i < lines.length && currentLine < linesToSkip; i += 2) {
      startIndex += lines[i].length;
      if (i + 1 < lines.length) {
        startIndex += lines[i + 1].length;
      }
      currentLine++;
    }

    return content.slice(startIndex);
  }

  /**
   * Get the current absolute offset without returning content.
   * Flushes any pending buffer first, then returns `liveBaseOffset + fileSize`.
   */
  async getCurrentOffset(sessionId: string, workerId: string, resolver: SessionDataPathResolver): Promise<number> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, async () => {
      await this.flushLocked(sessionId, workerId);
      try {
        const manifest = await this.loadManifestWithRecovery(sessionId, workerId, resolver);
        const liveBuffer = await this.readLiveBuffer(sessionId, workerId, resolver);
        return manifest.liveBaseOffset + liveBuffer.length;
      } catch (error) {
        logger.error({ sessionId, workerId, err: error }, 'Failed to get file offset');
        return 0;
      }
    });
  }

  /**
   * Serve a backwards history range: the bytes ending at (strictly before)
   * absolute `beforeOffset`, clamped to ONE storage unit (a single archived
   * segment or the live window) and to `min(maxBytes, rangeMaxBytes)` (§5.1/§5.2).
   * Joins the per-worker serialization domain so the manifest lookup, live read,
   * and epoch capture are all coherent with concurrent appends / cuts / resets.
   *
   * Callers (route boundary) validate the numeric inputs; this method assumes a
   * non-negative `beforeOffset` and treats a missing segment file as an
   * unavailable range (filesystem-driven availability, §5.1). It throws only on
   * genuinely unexpected I/O so the caller can map that to `HISTORY_LOAD_FAILED`.
   */
  async readHistoryRange(
    sessionId: string,
    workerId: string,
    resolver: SessionDataPathResolver,
    beforeOffset: number,
    maxBytes?: number,
  ): Promise<HistoryRangeResult> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, async () => {
      const manifest = await this.loadManifestWithRecovery(sessionId, workerId, resolver);
      const epoch = manifest.epoch;
      const firstAvailable = firstAvailableOffset(manifest);
      const base = manifest.liveBaseOffset;

      // Unavailable-range shape: pruned, invalid, or at/before the earliest byte.
      const unavailable = (): HistoryRangeResult => ({
        data: '',
        startOffset: beforeOffset,
        endOffset: beforeOffset,
        hasMore: false,
        epoch,
      });

      const pending = this.pendingFlushes.get(key);
      const pendingBuffer = pending?.buffer || '';
      const pendingByteLength = Buffer.byteLength(pendingBuffer, 'utf-8');
      const liveBuffer = await this.readLiveBuffer(sessionId, workerId, resolver);
      const fileSize = liveBuffer.length;
      const total = base + fileSize + pendingByteLength;

      // Clamp the requested end to the end of the stream.
      const readEnd = Math.min(beforeOffset, total);
      if (readEnd <= firstAvailable) {
        return unavailable();
      }

      // A `maxBytes` of 0 (or negative) cannot make progress and would loop the
      // client; ignore the hint and use the server cap instead.
      const cap = this.config.rangeMaxBytes;
      const wantBytes = maxBytes === undefined || maxBytes <= 0 ? cap : Math.min(maxBytes, cap);

      // Live window unit: [base, total).
      if (readEnd > base) {
        const liveWindow = Buffer.concat([liveBuffer, Buffer.from(pendingBuffer, 'utf-8')]);
        return this.sliceRangeUnit(liveWindow, base, total, readEnd, wantBytes, firstAvailable, epoch);
      }

      // Otherwise the byte lives in an archived segment.
      const seg = manifest.segments.find((s) => readEnd > s.startOffset && readEnd <= s.endOffset);
      if (!seg) {
        // No segment covers it (a prune raced the read) — filesystem-driven
        // availability says this range is gone.
        return unavailable();
      }

      const segPath = path.join(this.getWorkerDir(sessionId, resolver), seg.file);
      let segBuffer: Buffer;
      try {
        segBuffer = await this.getDecompressedSegment(key, seg, segPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Manifest references a segment whose file is absent (crash window
          // between retention's file-delete and manifest-rewrite, or a prune
          // racing the read). Availability is filesystem-driven → unavailable.
          return unavailable();
        }
        throw error;
      }

      return this.sliceRangeUnit(segBuffer, seg.startOffset, seg.endOffset, readEnd, wantBytes, firstAvailable, epoch);
    });
  }

  /**
   * Slice the trailing `wantBytes` of a single storage unit (`unit` covers the
   * absolute range `[unitStart, unitEnd)`) ending at `readEnd`, applying boundary
   * hygiene only when the slice was clamped inside the unit (§5.2).
   */
  private sliceRangeUnit(
    unit: Buffer,
    unitStart: number,
    unitEnd: number,
    readEnd: number,
    wantBytes: number,
    firstAvailable: number,
    epoch: number,
  ): HistoryRangeResult {
    const endOffset = Math.min(readEnd, unitEnd);
    let startByte = Math.max(unitStart, endOffset - wantBytes);

    // Boundary hygiene (UTF-8 + best-effort newline) applies only when we clamped
    // strictly inside the unit: there is then guaranteed-contiguous older content
    // in the same unit that a follow-up request (beforeOffset = startOffset) will
    // re-serve, so trimming a partial leading line loses nothing. At the exact
    // unit start we serve from the true boundary — cut points are UTF-8 aligned,
    // and the older unit (if any) is contiguous — so trimming there would drop
    // the earliest bytes and wrongly flip `hasMore`.
    if (startByte > unitStart) {
      startByte = this.alignRangeStart(unit, startByte, unitStart, endOffset);
    }

    const relStart = startByte - unitStart;
    const relEnd = endOffset - unitStart;
    const data = unit.subarray(relStart, relEnd).toString('utf-8');
    return {
      data,
      startOffset: startByte,
      endOffset,
      hasMore: startByte > firstAvailable,
      epoch,
    };
  }

  /**
   * Advance an absolute range start to a clean boundary: first past any UTF-8
   * continuation bytes (0x80-0xBF), then to the byte after the first `\n` within
   * the scan window, if one exists before `endOffset`. Never advances past
   * `endOffset` (the scan is bounded by it), so the resulting slice is non-negative.
   */
  private alignRangeStart(unit: Buffer, absStart: number, unitStart: number, endOffset: number): number {
    let rel = absStart - unitStart;
    const relEnd = endOffset - unitStart;
    while (rel < relEnd && (unit[rel] & 0xc0) === 0x80) rel++;
    const scanEnd = Math.min(rel + NEWLINE_ALIGN_SCAN_BYTES, relEnd);
    for (let i = rel; i < scanEnd; i++) {
      if (unit[i] === 0x0a) {
        const candidate = unitStart + i + 1;
        // Only align if at least one byte remains; a lone trailing newline at
        // endOffset-1 must not strand the slice empty (that would leave the
        // client without progress and loop the same beforeOffset).
        if (candidate < endOffset) return candidate;
        break;
      }
    }
    return unitStart + rel;
  }

  /**
   * Return the decompressed bytes of `seg`, sharing one inflation across readers
   * via the per-worker single-entry cache (§5.2). The promise is installed in the
   * slot BEFORE inflation begins; the caller must use the returned promise's
   * result directly and never re-read the cache slot after awaiting it.
   */
  private getDecompressedSegment(key: string, seg: SegmentMeta, segPath: string): Promise<Buffer> {
    const cached = this.segmentCache.get(key);
    if (cached && cached.seq === seg.seq) {
      return cached.promise;
    }

    // Different seq (or empty slot): evict the old entry and install a new one
    // before the inflation starts.
    if (cached) {
      clearTimeout(cached.timer);
    }
    const promise = fs.readFile(segPath).then((gz) => gunzipAsync(gz));
    const timer = setTimeout(() => {
      if (this.segmentCache.get(key) === entry) {
        this.segmentCache.delete(key);
      }
    }, SEGMENT_CACHE_TTL_MS);
    timer.unref?.();
    const entry: DecompressedSegmentEntry = { seq: seg.seq, promise, timer };
    this.segmentCache.set(key, entry);

    // Do not cache a failed inflation (missing file / corruption): evict so a
    // later request re-reads from disk. The awaiting caller still sees the
    // rejection via its own captured `promise`.
    promise.catch(() => {
      if (this.segmentCache.get(key) === entry) {
        clearTimeout(entry.timer);
        this.segmentCache.delete(key);
      }
    });

    return promise;
  }

  /** Drop a worker's cached decompressed segment (prune / reset / delete). */
  private invalidateSegmentCache(key: string): void {
    const entry = this.segmentCache.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.segmentCache.delete(key);
    }
  }

  // ========== Lifecycle ==========

  /**
   * Reset output for a worker (restart): drop all content storage (live file +
   * segments), rewrite the manifest with a **new epoch** so the absolute stream
   * genuinely restarts at 0 under a new generation. Runs inside the domain so it
   * is atomic with respect to in-flight flushes.
   */
  async resetWorkerOutput(sessionId: string, workerId: string, resolver: SessionDataPathResolver): Promise<number> {
    const key = this.getKey(sessionId, workerId);
    return this.runExclusive(key, async () => {
      // Drop any pending flush without writing it, and the cached segment (the
      // reset rewinds the stream to 0; any prior-incarnation segment is gone).
      const pending = this.pendingFlushes.get(key);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingFlushes.delete(key);
      }
      this.invalidateSegmentCache(key);

      const filePath = this.getOutputFilePath(sessionId, workerId, resolver);
      const dir = this.getWorkerDir(sessionId, resolver);
      const manifestPath = this.getManifestPath(sessionId, workerId, resolver);

      // Mint the new epoch up-front so BOTH the happy path and the error path
      // agree on the exact value (guard against a same-ms / regressed clock vs
      // the old incarnation). readManifest returns null on any read error, so
      // this never throws.
      const oldManifest = await readManifest(manifestPath);
      let newEpoch = this.mintEpoch();
      if (oldManifest && newEpoch <= oldManifest.epoch) {
        newEpoch = oldManifest.epoch + 1;
      }

      try {
        await fs.mkdir(dir, { recursive: true });

        // Delete existing content: live file, legacy compressed, and all segments.
        await this.deleteContentFiles(dir, sessionId, workerId, resolver, oldManifest);

        // Fresh manifest (base 0, no segments) with the new epoch.
        const manifest = createInitialManifest(newEpoch);
        await writeManifestDurable(manifestPath, manifest);
        this.recovered.add(key);

        // Create an empty live file.
        await fs.writeFile(filePath, '', 'utf-8');

        logger.debug({ sessionId, workerId, epoch: newEpoch }, 'Reset worker output (new epoch)');
        return newEpoch;
      } catch (error) {
        logger.error({ sessionId, workerId, err: error }, 'Failed to reset worker output file');
        // Best-effort: persist the NEW epoch so the on-disk manifest matches the
        // epoch the restarted worker will carry. NEVER fall back to the old
        // epoch: a reset rewinds the absolute stream to 0, so reusing the old
        // generation would let a client holding a pre-reset offset later accept
        // unrelated new-incarnation bytes as authoritative — exactly the
        // coordinate-aliasing hazard the epoch exists to prevent (§3.4).
        try {
          await fs.mkdir(dir, { recursive: true });
          await writeManifestDurable(manifestPath, createInitialManifest(newEpoch));
          this.recovered.add(key);
          return newEpoch;
        } catch (persistError) {
          // Residual divergence window: the new epoch could not be persisted, so
          // the returned (in-memory) epoch leads the on-disk manifest until the
          // next successful manifest write. Because reads honor an epoch hint
          // ONLY when the manifest is missing, a stale old manifest that survived
          // on disk would still read as the old epoch until a later successful
          // reset/init rewrites it. Logged at error level so this is visible.
          logger.error(
            { sessionId, workerId, err: persistError, epoch: newEpoch },
            'Failed to persist new epoch on reset error path; in-memory epoch is unpersisted (residual divergence until the next successful manifest write)',
          );
          return newEpoch;
        }
      }
    });
  }

  /**
   * Delete output for a worker (worker deletion): live file, legacy compressed,
   * all segments, AND the manifest — the worker identity itself is gone.
   */
  async deleteWorkerOutput(sessionId: string, workerId: string, resolver: SessionDataPathResolver): Promise<void> {
    const key = this.getKey(sessionId, workerId);
    await this.runExclusive(key, async () => {
      const pending = this.pendingFlushes.get(key);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingFlushes.delete(key);
      }
      this.invalidateSegmentCache(key);

      const dir = this.getWorkerDir(sessionId, resolver);
      const manifestPath = this.getManifestPath(sessionId, workerId, resolver);
      const manifest = await readManifest(manifestPath);

      await this.deleteContentFiles(dir, sessionId, workerId, resolver, manifest);
      await fs.unlink(manifestPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ sessionId, workerId, manifestPath, err }, 'Failed to delete manifest during worker deletion');
        }
      });
      this.recovered.delete(key);

      logger.debug({ sessionId, workerId }, 'Deleted worker output (files + manifest)');
    });
  }

  /**
   * Delete the live file, legacy compressed file, and every segment file for a
   * worker. Segment file names come from the manifest when available, and are
   * also scanned from disk so orphans are swept too.
   */
  private async deleteContentFiles(
    dir: string,
    sessionId: string,
    workerId: string,
    resolver: SessionDataPathResolver,
    manifest: WorkerOutputManifest | null,
  ): Promise<void> {
    const filePath = this.getOutputFilePath(sessionId, workerId, resolver);
    const compressedPath = path.join(dir, `${workerId}.log.gz`);

    const unlinkIgnore = async (p: string): Promise<void> => {
      await fs.unlink(p).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ sessionId, workerId, path: p, err }, 'Failed to delete output content file');
        }
      });
    };

    await unlinkIgnore(filePath);
    await unlinkIgnore(compressedPath);

    // Collect segment file names from the manifest and from a disk scan.
    const segFiles = new Set<string>(manifest?.segments.map((s) => s.file) ?? []);
    const re = segmentFileRegex(workerId);
    try {
      for (const entry of await fs.readdir(dir)) {
        if (re.test(entry)) segFiles.add(entry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ dir, err }, 'Failed to scan segment files for deletion');
      }
    }
    for (const file of segFiles) {
      await unlinkIgnore(path.join(dir, file));
    }
  }

  /**
   * Delete all output files for a session (session deletion). Drains in-flight
   * flushes for known workers, then removes the whole `outputs/<sessionId>` dir.
   */
  async deleteSessionOutputs(sessionId: string, resolver: SessionDataPathResolver): Promise<void> {
    const prefix = `${sessionId}/`;

    // Cancel pending flush timers for this session and drop their buffers.
    for (const [key, pending] of this.pendingFlushes) {
      if (key.startsWith(prefix)) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingFlushes.delete(key);
        this.recovered.delete(key);
      }
    }

    // Drop any cached decompressed segments for this session's workers.
    for (const key of Array.from(this.segmentCache.keys())) {
      if (key.startsWith(prefix)) this.invalidateSegmentCache(key);
    }

    // Drain EVERY in-flight locked operation for this session — not just those
    // with a pending flush. A concurrent range/history read or cut holds a lock
    // in `this.locks` (every runExclusive registers there) but may have no
    // pendingFlushes entry; draining only the flush keys would let such an op
    // recreate files after the directory removal. Joining each worker's lock
    // chain here makes the rm atomic with respect to any locked op.
    const lockKeys = Array.from(this.locks.keys()).filter((key) => key.startsWith(prefix));
    for (const key of lockKeys) this.recovered.delete(key);
    await Promise.all(lockKeys.map((key) => this.runExclusive(key, async () => {})));

    const sessionDir = path.join(resolver.getOutputsDir(), sessionId);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
      logger.debug({ sessionId }, 'Deleted session output directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ sessionId, err: error }, 'Failed to delete session output directory');
      }
    }
  }

  /**
   * Force flush all pending buffers.
   * Useful for graceful shutdown.
   */
  async flushAll(): Promise<void> {
    const flushPromises: Promise<void>[] = [];
    for (const key of this.pendingFlushes.keys()) {
      const [sessionId, workerId] = key.split('/');
      flushPromises.push(this.flushBuffer(sessionId, workerId));
    }
    await Promise.all(flushPromises);
  }
}
