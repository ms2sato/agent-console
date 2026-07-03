/**
 * Tests for the segmented-archive behavior of WorkerOutputFileManager
 * (terminal-history-paging.md §3 / §4): absolute offsets, gzip cut + manifest,
 * crash recovery, epoch, retention, lifecycle deletions, and serving-rule branches.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as path from 'path';
import { gunzipSync } from 'node:zlib';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { vol, fs as memfs } from 'memfs';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import {
  readManifest,
  writeManifestDurable,
  createInitialManifest,
  manifestPathFor,
  type WorkerOutputManifest,
} from '../worker-output-manifest.js';

const CONFIG_DIR = '/test/config';
const resolver = new SessionDataPathResolver(`${CONFIG_DIR}/_quick`);
const S = 'session-1';
const W = 'w-1';

const outputsDir = resolver.getOutputsDir();
const workerDir = path.join(outputsDir, S);
const logPath = resolver.getOutputFilePath(S, W);
const manifestPath = manifestPathFor(outputsDir, S, W);

// fileMaxSize small so cuts are easy to trigger; huge flush threshold so
// bufferOutput never auto-flushes — flushAll() drives every write deterministically.
const FILE_MAX = 100;
const HUGE_THRESHOLD = 100_000_000;

function makeManager(overrides?: { fileMaxSize?: number; maxSegments?: number }): WorkerOutputFileManager {
  return new WorkerOutputFileManager({
    flushThreshold: HUGE_THRESHOLD,
    flushInterval: 100_000,
    fileMaxSize: overrides?.fileMaxSize ?? FILE_MAX,
    maxSegments: overrides?.maxSegments ?? 0,
  });
}

/** Buffer `data` and flush it (triggering a cut when the live file overflows). */
async function writeAndFlush(m: WorkerOutputFileManager, data: string): Promise<void> {
  m.bufferOutput(S, W, data, resolver);
  await m.flushAll();
}

function segFiles(): string[] {
  return vol
    .readdirSync(workerDir)
    .filter((f) => /^w-1\.seg-\d+\.log\.gz$/.test(String(f)))
    .map(String)
    .sort();
}

describe('WorkerOutputFileManager — segmented archive', () => {
  let manager: WorkerOutputFileManager;

  beforeEach(() => {
    setupMemfs({});
    process.env.AGENT_CONSOLE_HOME = CONFIG_DIR;
    manager = makeManager();
  });

  afterEach(() => {
    cleanupMemfs();
  });

  describe('cut operation', () => {
    it('archives the head into a gzip segment and rewrites the live file to the remainder', async () => {
      await writeAndFlush(manager, 'a'.repeat(200));

      const m = await readManifest(manifestPath);
      expect(m).not.toBeNull();
      expect(m!.segments).toHaveLength(1);

      const seg = m!.segments[0];
      const targetSize = Math.floor(FILE_MAX * 0.8); // 80
      const cutBytes = 200 - targetSize; // 120
      expect(seg.seq).toBe(0);
      expect(seg.startOffset).toBe(0);
      expect(seg.endOffset).toBe(cutBytes);
      expect(seg.bytes).toBe(cutBytes);
      expect(m!.liveBaseOffset).toBe(cutBytes);
      expect(m!.nextSeq).toBe(1);
      expect(m!.pendingCut).toBeNull();

      // Live file holds only the remainder.
      expect(vol.readFileSync(logPath).length).toBe(targetSize);

      // Segment gunzips back to the archived head.
      const gz = vol.readFileSync(path.join(workerDir, seg.file));
      expect(gunzipSync(gz).toString('utf-8')).toBe('a'.repeat(cutBytes));
    });

    it('advances the cut point to a UTF-8 boundary for multi-byte content', async () => {
      // Each 'あ' is 3 bytes. 100 of them = 300 bytes.
      await writeAndFlush(manager, 'あ'.repeat(100));

      const m = await readManifest(manifestPath);
      const seg = m!.segments[0];
      const gz = vol.readFileSync(path.join(workerDir, seg.file));
      const head = gunzipSync(gz);
      const remainder = vol.readFileSync(logPath);

      // Neither slice may start/end mid-codepoint: decode round-trips cleanly.
      const decodedHead = head.toString('utf-8');
      const decodedRemainder = remainder.toString('utf-8');
      expect(decodedHead + decodedRemainder).toBe('あ'.repeat(100));
      // Head byte length is a multiple of 3 (whole 'あ' chars only).
      expect(head.length % 3).toBe(0);
    });

    it('fsyncs during a cut (segment write, manifest writes, live-file rewrite)', async () => {
      const syncSpy = spyOn(memfs.promises.FileHandle.prototype, 'sync');
      await writeAndFlush(manager, 'a'.repeat(200));
      // Segment + 2 manifest writes + live-file rewrite, each fsyncs file + dir.
      expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
      syncSpy.mockRestore();
    });
  });

  describe('absolute offsets across cuts', () => {
    it('history/getCurrentOffset are absolute (cumulative) after multiple cuts', async () => {
      await writeAndFlush(manager, 'a'.repeat(200)); // cut 1
      await writeAndFlush(manager, 'b'.repeat(200)); // cut 2

      const totalWritten = 400;
      const current = await manager.getCurrentOffset(S, W, resolver);
      expect(current).toBe(totalWritten);

      const hist = await manager.readHistoryWithOffset(S, W, resolver, undefined);
      // Initial full read returns the live window only; offset is absolute total.
      expect(hist.offset).toBe(totalWritten);
      expect(hist.startOffset).toBe(hist.offset - Buffer.byteLength(hist.data, 'utf-8'));
      expect(hist.startOffset).toBeGreaterThan(0); // live base advanced past 0

      const m = await readManifest(manifestPath);
      expect(m!.liveBaseOffset).toBe(hist.startOffset);
    });

    it('includes the pending buffer in the absolute total', async () => {
      await writeAndFlush(manager, 'a'.repeat(200)); // one cut, live=80, base=120
      manager.bufferOutput(S, W, 'xyz', resolver); // pending, not flushed
      const hist = await manager.readHistoryWithOffset(S, W, resolver, undefined);
      expect(hist.offset).toBe(203);
      expect(hist.data.endsWith('xyz')).toBe(true);
    });
  });

  describe('serving-rule branches (§3.1)', () => {
    it('normal incremental: base <= fromOffset < total serves the live continuation', async () => {
      await writeAndFlush(manager, 'a'.repeat(200)); // base=120, live=80, total=200
      const from = 160; // within live window
      const hist = await manager.readHistoryWithOffset(S, W, resolver, from, 5000);
      expect(hist.startOffset).toBe(from);
      expect(hist.offset).toBe(200);
      expect(Buffer.byteLength(hist.data, 'utf-8')).toBe(200 - from);
    });

    it('below-base: fromOffset < liveBaseOffset returns recent window with startOffset > fromOffset', async () => {
      await writeAndFlush(manager, 'a'.repeat(200)); // base=120
      const hist = await manager.readHistoryWithOffset(S, W, resolver, 10, 5000);
      expect(hist.startOffset).toBeGreaterThan(10);
      expect(hist.offset).toBe(200);
    });

    it('above-total: fromOffset > total returns recent window lying entirely below the request', async () => {
      await writeAndFlush(manager, 'a'.repeat(200)); // total=200
      const hist = await manager.readHistoryWithOffset(S, W, resolver, 9999, 5000);
      expect(hist.startOffset).toBeLessThan(9999);
      expect(hist.startOffset).toBeLessThanOrEqual(hist.offset);
      expect(hist.offset).toBe(200);
    });

    it('boundary: fromOffset === total returns empty at total', async () => {
      await writeAndFlush(manager, 'a'.repeat(200));
      const hist = await manager.readHistoryWithOffset(S, W, resolver, 200, 5000);
      expect(hist.data).toBe('');
      expect(hist.offset).toBe(200);
      expect(hist.startOffset).toBe(200);
    });

    it('boundary: empty worker returns empty at offset 0', async () => {
      await manager.initializeWorkerOutput(S, W, resolver, 555);
      const hist = await manager.readHistoryWithOffset(S, W, resolver, undefined);
      expect(hist.data).toBe('');
      expect(hist.offset).toBe(0);
      expect(hist.startOffset).toBe(0);
      expect(hist.epoch).toBe(555);
    });
  });

  describe('epoch', () => {
    it('records the passed epoch and returns it stably (mint/persist)', async () => {
      const e = await manager.initializeWorkerOutput(S, W, resolver, 42);
      expect(e).toBe(42);
      expect(await manager.getEpoch(S, W, resolver)).toBe(42);
      const m = await readManifest(manifestPath);
      expect(m!.epoch).toBe(42);
    });

    it('mints a fresh epoch when the manifest is missing (never reuses)', async () => {
      // No initialize — a bare read lazily creates the manifest with a mint.
      const hist = await manager.readHistoryWithOffset(S, W, resolver, undefined);
      expect(hist.epoch).toBeGreaterThan(0);
      // Persisted and stable on the next read.
      expect(await manager.getEpoch(S, W, resolver)).toBe(hist.epoch);
    });

    it('resetWorkerOutput mints a NEW epoch distinct from the old across repeated resets', async () => {
      const e0 = await manager.initializeWorkerOutput(S, W, resolver, 1000);
      const e1 = await manager.resetWorkerOutput(S, W, resolver);
      const e2 = await manager.resetWorkerOutput(S, W, resolver);
      expect(e1).not.toBe(e0);
      expect(e2).not.toBe(e1);
      // Comparison is equality-only: distinctness is what matters, not order.
      const m = await readManifest(manifestPath);
      expect(m!.epoch).toBe(e2);
    });

    it('resetWorkerOutput bumps past a same-ms/regressed clock so the epoch still differs', async () => {
      await manager.initializeWorkerOutput(S, W, resolver, Number.MAX_SAFE_INTEGER - 1);
      const before = (await readManifest(manifestPath))!.epoch;
      const reset = await manager.resetWorkerOutput(S, W, resolver);
      // Date.now() is far below MAX_SAFE_INTEGER, so the guard bumps to old+1.
      expect(reset).toBe(before + 1);
    });
  });

  describe('crash recovery (two-phase cut)', () => {
    async function seedManifest(m: WorkerOutputManifest): Promise<void> {
      await memfs.promises.mkdir(workerDir, { recursive: true });
      await writeManifestDurable(manifestPath, m);
    }

    it('pendingCut with live file at expectedLiveSizeAfter + bytes → redo step 3 (rewrite)', async () => {
      // Live file still contains head+remainder (step 3 never ran).
      const remainder = 'R'.repeat(80);
      const head = 'H'.repeat(120);
      vol.mkdirSync(workerDir, { recursive: true });
      vol.writeFileSync(logPath, head + remainder);
      await seedManifest({
        version: 1,
        epoch: 7,
        liveBaseOffset: 120,
        nextSeq: 1,
        pendingCut: { bytes: 120, expectedLiveSizeAfter: 80 },
        segments: [{ seq: 0, startOffset: 0, endOffset: 120, bytes: 120, gzBytes: 5, file: 'w-1.seg-0.log.gz' }],
      });

      // Access triggers lazy recovery.
      await manager.getEpoch(S, W, resolver);

      expect(vol.readFileSync(logPath, 'utf-8')).toBe(remainder);
      expect((await readManifest(manifestPath))!.pendingCut).toBeNull();
    });

    it('pendingCut with live file already at expectedLiveSizeAfter → step 3 skipped, finalized', async () => {
      const remainder = 'R'.repeat(80);
      vol.mkdirSync(workerDir, { recursive: true });
      vol.writeFileSync(logPath, remainder);
      await seedManifest({
        version: 1,
        epoch: 7,
        liveBaseOffset: 120,
        nextSeq: 1,
        pendingCut: { bytes: 120, expectedLiveSizeAfter: 80 },
        segments: [{ seq: 0, startOffset: 0, endOffset: 120, bytes: 120, gzBytes: 5, file: 'w-1.seg-0.log.gz' }],
      });

      await manager.getEpoch(S, W, resolver);

      expect(vol.readFileSync(logPath, 'utf-8')).toBe(remainder); // unchanged
      expect((await readManifest(manifestPath))!.pendingCut).toBeNull();
    });

    it('orphan segment file not in the manifest is deleted on first access', async () => {
      vol.mkdirSync(workerDir, { recursive: true });
      vol.writeFileSync(logPath, 'live');
      vol.writeFileSync(path.join(workerDir, 'w-1.seg-9.log.gz'), 'orphan');
      await seedManifest(createInitialManifest(7)); // no segments referenced

      await manager.getEpoch(S, W, resolver);

      expect(vol.existsSync(path.join(workerDir, 'w-1.seg-9.log.gz'))).toBe(false);
    });

    it('recovers a pendingCut written AFTER the first access (not gated by once-per-process recovery)', async () => {
      // First access establishes a clean manifest and sets the `recovered` flag.
      await manager.initializeWorkerOutput(S, W, resolver, 7);

      // A later cut fails mid-way (step 2 committed pendingCut, step 3 never ran):
      // simulate by writing a pendingCut manifest + un-cut live file directly.
      const remainder = 'R'.repeat(80);
      const head = 'H'.repeat(120);
      vol.writeFileSync(logPath, head + remainder);
      await writeManifestDurable(manifestPath, {
        version: 1,
        epoch: 7,
        liveBaseOffset: 120,
        nextSeq: 1,
        pendingCut: { bytes: 120, expectedLiveSizeAfter: 80 },
        segments: [{ seq: 0, startOffset: 0, endOffset: 120, bytes: 120, gzBytes: 5, file: 'w-1.seg-0.log.gz' }],
      });

      // A subsequent read must STILL run recovery even though `recovered` is set.
      await manager.readHistoryWithOffset(S, W, resolver, undefined);

      expect(vol.readFileSync(logPath, 'utf-8')).toBe(remainder);
      expect((await readManifest(manifestPath))!.pendingCut).toBeNull();
    });

    it('completed manifest (pendingCut null) is idempotent — no-op', async () => {
      vol.mkdirSync(workerDir, { recursive: true });
      vol.writeFileSync(logPath, 'R'.repeat(80));
      const clean = createInitialManifest(7);
      clean.liveBaseOffset = 120;
      await seedManifest(clean);

      await manager.getEpoch(S, W, resolver);
      expect(await readManifest(manifestPath)).toEqual(clean);
    });
  });

  describe('retention prune (§4.4)', () => {
    it('caps segments and deletes the oldest files; seq stays monotonic with gaps', async () => {
      const m = makeManager({ fileMaxSize: 100, maxSegments: 2 });
      await writeAndFlush(m, 'a'.repeat(200));
      await writeAndFlush(m, 'b'.repeat(200));
      await writeAndFlush(m, 'c'.repeat(200));
      await writeAndFlush(m, 'd'.repeat(200));

      const man = await readManifest(manifestPath);
      expect(man!.segments).toHaveLength(2);
      // Only the two newest survive; seq keeps growing (older seqs pruned).
      const seqs = man!.segments.map((s) => s.seq);
      expect(seqs[1] - seqs[0]).toBe(1);
      expect(seqs[0]).toBeGreaterThan(0);
      // Disk holds exactly the retained segment files.
      expect(segFiles()).toHaveLength(2);
      // liveBaseOffset keeps advancing; firstAvailableOffset rose above 0.
      expect(man!.segments[0].startOffset).toBeGreaterThan(0);
      // Invariant (commit-before-delete): the committed manifest never
      // references a segment file that has already been deleted from disk.
      for (const seg of man!.segments) {
        expect(vol.existsSync(path.join(workerDir, seg.file))).toBe(true);
      }
    });

    it('finalizes the pruned manifest even when a pruned-file delete fails (commit-before-delete)', async () => {
      // Commit-before-delete means the manifest is durably written with the
      // pruned segment list + pendingCut cleared BEFORE the files are unlinked.
      // If a subsequent delete fails, the manifest must still be correct (pruned
      // + finalized), never left with pendingCut set or referencing the file.
      const m = makeManager({ fileMaxSize: 100, maxSegments: 1 });
      await writeAndFlush(m, 'a'.repeat(200)); // seg-0

      // Pre-remove seg-0's file so the prune-time unlink hits ENOENT (a delete
      // "failure" that is tolerated) during the next cut.
      vol.unlinkSync(path.join(workerDir, 'w-1.seg-0.log.gz'));

      await writeAndFlush(m, 'b'.repeat(200)); // seg-1 cut; prunes seg-0

      const man = await readManifest(manifestPath);
      // pendingCut cleared and seg-0 dropped from the manifest despite the
      // missing file — the manifest commit is independent of the file delete.
      expect(man!.pendingCut).toBeNull();
      expect(man!.segments).toHaveLength(1);
      expect(man!.segments[0].file).toBe('w-1.seg-1.log.gz');
      // Every referenced segment file still exists on disk.
      expect(vol.existsSync(path.join(workerDir, 'w-1.seg-1.log.gz'))).toBe(true);
    });

    it('maxSegments 0 = unlimited retention', async () => {
      const m = makeManager({ fileMaxSize: 100, maxSegments: 0 });
      await writeAndFlush(m, 'a'.repeat(200));
      await writeAndFlush(m, 'b'.repeat(200));
      await writeAndFlush(m, 'c'.repeat(200));
      expect((await readManifest(manifestPath))!.segments).toHaveLength(3);
    });
  });

  describe('lifecycle deletions (§4.5)', () => {
    it('deleteWorkerOutput removes live file, segments, and the manifest', async () => {
      await writeAndFlush(manager, 'a'.repeat(200));
      expect(segFiles().length).toBe(1);

      await manager.deleteWorkerOutput(S, W, resolver);

      expect(vol.existsSync(logPath)).toBe(false);
      expect(vol.existsSync(manifestPath)).toBe(false);
      expect(segFiles().length).toBe(0);
    });

    it('deleteSessionOutputs removes the whole session directory', async () => {
      await writeAndFlush(manager, 'a'.repeat(200));
      await manager.deleteSessionOutputs(S, resolver);
      expect(vol.existsSync(workerDir)).toBe(false);
    });
  });

  describe('lock serialization (§4.3)', () => {
    it('concurrent flushes during cuts conserve all bytes (no loss between cut steps)', async () => {
      const m = makeManager({ fileMaxSize: 100, maxSegments: 0 });
      // Fire many buffered writes and flushes concurrently; the per-worker lock
      // serializes append/flush/cut so no append is lost by a mid-cut rewrite.
      const chunks = Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(50));
      await Promise.all(
        chunks.map((c) => {
          m.bufferOutput(S, W, c, resolver);
          return m.flushAll();
        }),
      );
      await m.flushAll();

      const totalBytes = chunks.reduce((n, c) => n + c.length, 0);
      // Accounting: segments' bytes + live file length == total written.
      const man = await readManifest(manifestPath);
      const archived = man!.segments.reduce((n, s) => n + s.bytes, 0);
      const live = vol.readFileSync(logPath).length;
      expect(archived + live).toBe(totalBytes);
      // Absolute offset equals the full cumulative total.
      expect(man!.liveBaseOffset + live).toBe(totalBytes);
    });
  });

  describe('migration from pre-upgrade destructive truncation (§3.3 / §8)', () => {
    it('a stale fromOffset above a head-trimmed no-manifest file returns a recent window below the request', async () => {
      // Simulate the pre-upgrade state: a head-trimmed live file, NO manifest,
      // and a client holding a lastOffset larger than the file (fed by
      // never-rebased output offsets before the upgrade).
      vol.mkdirSync(workerDir, { recursive: true });
      vol.writeFileSync(logPath, 'tail-after-old-truncation\n');
      const staleFromOffset = 9_000_000;

      const hist = await manager.readHistoryWithOffset(S, W, resolver, staleFromOffset, 5000);

      // The response's window lies entirely below the request — the client's
      // resync predicate (startOffset !== requestedFromOffset) resets and treats
      // it as a fresh load. No loop, no crash.
      expect(hist.startOffset).toBeLessThan(staleFromOffset);
      expect(hist.offset).toBeLessThan(staleFromOffset);
      expect(hist.data).toContain('tail-after-old-truncation');
      // A manifest is lazily created with base 0 and a fresh epoch.
      const m = await readManifest(manifestPath);
      expect(m!.liveBaseOffset).toBe(0);
      expect(m!.epoch).toBeGreaterThan(0);
    });
  });

  describe('legacy compatibility', () => {
    it('a range/history read against an un-migrated legacy .log.gz serves at base 0', async () => {
      const { gzipSync } = await import('node:zlib');
      vol.mkdirSync(workerDir, { recursive: true });
      vol.writeFileSync(path.join(workerDir, `${W}.log.gz`), gzipSync(Buffer.from('legacy stream')));

      const hist = await manager.readHistoryWithOffset(S, W, resolver, undefined);
      expect(hist.data).toBe('legacy stream');
      expect(hist.startOffset).toBe(0);
      expect(hist.offset).toBe('legacy stream'.length);
    });
  });
});
