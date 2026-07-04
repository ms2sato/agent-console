/**
 * Tests for backwards range serving in WorkerOutputFileManager
 * (terminal-history-paging.md §5.1 / §5.2): single-unit clamp, gz segment
 * round-trip, boundary hygiene, unavailable / hasMore semantics, ENOENT
 * fallback, the single-entry decompressed-segment cache, epoch tagging, and
 * legacy `.log.gz` serving.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { vol } from 'memfs';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import {
  readManifest,
  manifestPathFor,
  firstAvailableOffset,
} from '../worker-output-manifest.js';

const CONFIG_DIR = '/test/config';
const resolver = new SessionDataPathResolver(`${CONFIG_DIR}/_quick`);
const S = 'session-1';
const W = 'w-1';

const outputsDir = resolver.getOutputsDir();
const workerDir = path.join(outputsDir, S);
const manifestPath = manifestPathFor(outputsDir, S, W);
const key = `${S}/${W}`;

const FILE_MAX = 100;
const HUGE_THRESHOLD = 100_000_000;

function makeManager(overrides?: {
  fileMaxSize?: number;
  maxSegments?: number;
  rangeMaxBytes?: number;
}): WorkerOutputFileManager {
  return new WorkerOutputFileManager({
    flushThreshold: HUGE_THRESHOLD,
    flushInterval: 100_000,
    fileMaxSize: overrides?.fileMaxSize ?? FILE_MAX,
    maxSegments: overrides?.maxSegments ?? 0,
    rangeMaxBytes: overrides?.rangeMaxBytes ?? 1000,
  });
}

async function writeAndFlush(m: WorkerOutputFileManager, data: string): Promise<void> {
  m.bufferOutput(S, W, data, resolver);
  await m.flushAll();
}

/**
 * Build the fixture layout: three 100-byte flushes produce
 *   seg0 = [0,120)  seg1 = [120,220)  live = [220,300)
 * over the byte stream `'a'*100 + 'b'*100 + 'c'*100`. Returns that reference.
 */
async function buildThreeRegionFixture(m: WorkerOutputFileManager): Promise<string> {
  const full = 'a'.repeat(100) + 'b'.repeat(100) + 'c'.repeat(100);
  await writeAndFlush(m, 'a'.repeat(100));
  await writeAndFlush(m, 'b'.repeat(100));
  await writeAndFlush(m, 'c'.repeat(100));
  return full;
}

describe('WorkerOutputFileManager — backwards range serving', () => {
  let manager: WorkerOutputFileManager;

  beforeEach(() => {
    setupMemfs({});
    process.env.AGENT_CONSOLE_HOME = CONFIG_DIR;
    manager = makeManager();
  });

  afterEach(() => {
    cleanupMemfs();
  });

  describe('live-window serving', () => {
    it('serves the trailing slice of the live file ending at beforeOffset', async () => {
      const full = '0123456789'.repeat(10); // 100 bytes, no cut
      await writeAndFlush(manager, full);

      const res = await manager.readHistoryRange(S, W, resolver, 100, 20);
      expect(res.endOffset).toBe(100);
      expect(res.startOffset).toBe(80);
      expect(res.data).toBe(full.slice(80, 100));
      expect(res.hasMore).toBe(true);
    });

    it('clamps the served bytes to the server cap (rangeMaxBytes)', async () => {
      manager = makeManager({ rangeMaxBytes: 16 });
      const full = '0123456789'.repeat(10);
      await writeAndFlush(manager, full);

      const res = await manager.readHistoryRange(S, W, resolver, 100); // no maxBytes → cap
      expect(res.endOffset).toBe(100);
      expect(Buffer.byteLength(res.data, 'utf-8')).toBeLessThanOrEqual(16);
      expect(res.data).toBe(full.slice(res.startOffset, 100));
    });

    it('hasMore is false when the slice reaches the first available byte (offset 0)', async () => {
      const full = '0123456789'.repeat(10);
      await writeAndFlush(manager, full);

      const res = await manager.readHistoryRange(S, W, resolver, 100, 1000); // whole window
      expect(res.startOffset).toBe(0);
      expect(res.data).toBe(full);
      expect(res.hasMore).toBe(false);
    });

    it('best-effort newline alignment advances the start to a line head', async () => {
      const full = 'x'.repeat(50) + '\n' + 'y'.repeat(49); // '\n' at byte 50, total 100
      await writeAndFlush(manager, full);

      const res = await manager.readHistoryRange(S, W, resolver, 100, 70); // raw start = 30
      expect(res.startOffset).toBe(51); // byte after the first '\n'
      expect(res.data).toBe('y'.repeat(49));
      expect(res.endOffset).toBe(100);
    });

    it('a lone trailing newline does not strand the slice empty (client keeps progressing)', async () => {
      const full = 'a'.repeat(69) + '\n'; // only '\n' is the last byte (index 69)
      await writeAndFlush(manager, full);

      const res = await manager.readHistoryRange(S, W, resolver, 70, 40); // raw start = 30
      // Aligning to the byte after the trailing '\n' would produce start 70 ===
      // endOffset (empty). The guard keeps the UTF-8-aligned raw start instead.
      expect(res.startOffset).toBe(30);
      expect(res.data).toBe('a'.repeat(39) + '\n');
      expect(res.endOffset).toBe(70);
    });
  });

  describe('segment serving (real gz round-trip) and boundary clamps', () => {
    it('serves from within a gz segment, decompressing the real file', async () => {
      const full = await buildThreeRegionFixture(manager);
      const m = (await readManifest(manifestPath))!;
      expect(m.segments.length).toBe(2);

      // beforeOffset = seg1.endOffset (220); served from seg1 only.
      const res = await manager.readHistoryRange(S, W, resolver, 220, 50);
      expect(res.endOffset).toBe(220);
      expect(res.startOffset).toBe(170);
      expect(res.data).toBe(full.slice(170, 220));
      expect(res.hasMore).toBe(true);
    });

    it('clamps at the segment↔segment boundary (never stitches across seg0/seg1)', async () => {
      const full = await buildThreeRegionFixture(manager);

      // beforeOffset = 120 (= seg0.endOffset = seg1.startOffset) with a huge cap.
      const res = await manager.readHistoryRange(S, W, resolver, 120, 100000);
      expect(res.endOffset).toBe(120); // stops exactly at the seg0/seg1 seam
      expect(res.startOffset).toBe(0);
      expect(res.data).toBe(full.slice(0, 120));
      expect(res.hasMore).toBe(false); // seg0 starts at the first available byte
    });

    it('clamps at the segment↔live boundary (live unit never dips into seg1)', async () => {
      const full = await buildThreeRegionFixture(manager);

      // beforeOffset mid-live with a huge cap: start clamps to the live base (220).
      const res = await manager.readHistoryRange(S, W, resolver, 250, 100000);
      expect(res.startOffset).toBe(220); // = liveBaseOffset, not into seg1
      expect(res.endOffset).toBe(250);
      expect(res.data).toBe(full.slice(220, 250));
      expect(res.data).not.toContain('b'); // no segment bytes leaked in
      expect(res.hasMore).toBe(true);
    });

    it('a maxBytes larger than a segment still returns just that one segment', async () => {
      const full = await buildThreeRegionFixture(manager);

      const res = await manager.readHistoryRange(S, W, resolver, 220, 100000);
      expect(res.startOffset).toBe(120); // seg1.startOffset (unit start, no trim)
      expect(res.endOffset).toBe(220);
      expect(res.data).toBe(full.slice(120, 220));
    });
  });

  describe('unavailable ranges', () => {
    it('beforeOffset 0 → unavailable (nothing before the start)', async () => {
      await writeAndFlush(manager, 'hello');
      const res = await manager.readHistoryRange(S, W, resolver, 0, 100);
      expect(res).toEqual({ data: '', startOffset: 0, endOffset: 0, hasMore: false, epoch: expect.any(Number) });
    });

    it('a range at/below firstAvailableOffset after retention prune → unavailable', async () => {
      manager = makeManager({ maxSegments: 1 });
      await buildThreeRegionFixture(manager); // seg0 pruned; front is seg1 @120
      const m = (await readManifest(manifestPath))!;
      expect(firstAvailableOffset(m)).toBe(120);
      expect(m.segments.length).toBe(1);

      const below = await manager.readHistoryRange(S, W, resolver, 100, 1000);
      expect(below.data).toBe('');
      expect(below.hasMore).toBe(false);

      const at = await manager.readHistoryRange(S, W, resolver, 120, 1000);
      expect(at.data).toBe('');
      expect(at.hasMore).toBe(false);
    });

    it('serving the earliest surviving segment reports hasMore false at firstAvailableOffset', async () => {
      manager = makeManager({ maxSegments: 1 });
      const full = await buildThreeRegionFixture(manager); // front seg1 @120

      const res = await manager.readHistoryRange(S, W, resolver, 200, 100000);
      expect(res.startOffset).toBe(120);
      expect(res.data).toBe(full.slice(120, 200));
      expect(res.hasMore).toBe(false);
    });

    it('a missing (ENOENT) segment file is filesystem-driven unavailable, not an error', async () => {
      const full = await buildThreeRegionFixture(manager);
      const m = (await readManifest(manifestPath))!;
      const seg0 = m.segments[0];
      // Delete the segment file but keep the manifest referencing it.
      vol.unlinkSync(path.join(workerDir, seg0.file));

      const res = await manager.readHistoryRange(S, W, resolver, seg0.endOffset, 1000);
      expect(res.data).toBe('');
      expect(res.hasMore).toBe(false);
      // The live window is still served normally (only seg0 is gone).
      const live = await manager.readHistoryRange(S, W, resolver, 300, 50);
      expect(live.data).toBe(full.slice(250, 300));
    });
  });

  describe('decompressed-segment cache (§5.2)', () => {
    function segPath(seg: { file: string }): string {
      return path.join(workerDir, seg.file);
    }

    it('shares a single inflation for concurrent readers of the same segment', async () => {
      await buildThreeRegionFixture(manager);
      const m = (await readManifest(manifestPath))!;
      const seg0 = m.segments[0];

      // Two synchronous calls for the same seq return the identical promise.
      const p1 = (manager as unknown as { getDecompressedSegment: (k: string, s: unknown, p: string) => Promise<Buffer> })
        .getDecompressedSegment(key, seg0, segPath(seg0));
      const p2 = (manager as unknown as { getDecompressedSegment: (k: string, s: unknown, p: string) => Promise<Buffer> })
        .getDecompressedSegment(key, seg0, segPath(seg0));
      expect(p1).toBe(p2);
      const buf = await p1;
      expect(buf.equals(gunzipSync(vol.readFileSync(segPath(seg0)) as Buffer))).toBe(true);
    });

    it('two different segments racing never cross-serve bytes', async () => {
      await buildThreeRegionFixture(manager);
      const m = (await readManifest(manifestPath))!;
      const [segA, segB] = m.segments;
      const call = (seg: { file: string }, s: unknown) =>
        (manager as unknown as { getDecompressedSegment: (k: string, seg: unknown, p: string) => Promise<Buffer> })
          .getDecompressedSegment(key, s, segPath(seg));

      const [bufA, bufB] = await Promise.all([call(segA, segA), call(segB, segB)]);
      expect(bufA.equals(gunzipSync(vol.readFileSync(segPath(segA)) as Buffer))).toBe(true);
      expect(bufB.equals(gunzipSync(vol.readFileSync(segPath(segB)) as Buffer))).toBe(true);
      expect(bufA.equals(bufB)).toBe(false);
    });
  });

  describe('epoch tagging', () => {
    it('carries the manifest epoch on the range result', async () => {
      await writeAndFlush(manager, '0123456789'.repeat(10));
      const m = (await readManifest(manifestPath))!;
      const res = await manager.readHistoryRange(S, W, resolver, 100, 20);
      expect(res.epoch).toBe(m.epoch);
      expect(res.epoch).toBeGreaterThan(0);
    });

    it('reflects a new epoch after resetWorkerOutput', async () => {
      await writeAndFlush(manager, '0123456789'.repeat(10));
      const before = (await manager.readHistoryRange(S, W, resolver, 100, 20)).epoch;
      const newEpoch = await manager.resetWorkerOutput(S, W, resolver);
      expect(newEpoch).not.toBe(before);
      await writeAndFlush(manager, 'fresh');
      const after = (await manager.readHistoryRange(S, W, resolver, 5, 20)).epoch;
      expect(after).toBe(newEpoch);
    });

    it('a read racing a reset captures a coherent (never torn) epoch under the lock', async () => {
      await writeAndFlush(manager, '0123456789'.repeat(10));
      const preEpoch = (await readManifest(manifestPath))!.epoch;

      const [readRes, resetEpoch] = await Promise.all([
        manager.readHistoryRange(S, W, resolver, 100, 20),
        manager.resetWorkerOutput(S, W, resolver),
      ]);
      // The read is serialized against the reset: its epoch is one of the two
      // coherent generation values, never 0 or a mixed value.
      expect([preEpoch, resetEpoch]).toContain(readRes.epoch);
    });
  });

  describe('legacy .log.gz (hibernation-era) serving', () => {
    it('serves a range from an un-migrated legacy compressed file at base 0', async () => {
      const content = 'legacy stream line one\nlegacy stream line two\n';
      const total = Buffer.byteLength(content, 'utf-8');
      vol.mkdirSync(workerDir, { recursive: true });
      vol.writeFileSync(path.join(workerDir, `${W}.log.gz`), gzipSync(Buffer.from(content)));

      const res = await manager.readHistoryRange(S, W, resolver, total, 100000);
      expect(res.startOffset).toBe(0);
      expect(res.endOffset).toBe(total);
      expect(res.data).toBe(content);
      expect(res.hasMore).toBe(false);
    });
  });
});
