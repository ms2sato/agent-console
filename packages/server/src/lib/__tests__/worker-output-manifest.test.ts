import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { vol, fs as memfs } from 'memfs';
import {
  createInitialManifest,
  firstAvailableOffset,
  manifestPathFor,
  segmentFileRegex,
  readManifest,
  writeManifestDurable,
  writeFileDurable,
  MANIFEST_VERSION,
  type WorkerOutputManifest,
} from '../worker-output-manifest.js';

const DIR = '/test/outputs/session-1';
const MANIFEST_PATH = `${DIR}/w-1.segments.json`;

describe('worker-output-manifest', () => {
  beforeEach(() => {
    setupMemfs({});
    vol.mkdirSync(DIR, { recursive: true });
  });

  afterEach(() => {
    cleanupMemfs();
  });

  describe('createInitialManifest', () => {
    it('creates a base-0 manifest with the given epoch and no segments', () => {
      const m = createInitialManifest(12345);
      expect(m).toEqual({
        version: MANIFEST_VERSION,
        epoch: 12345,
        liveBaseOffset: 0,
        nextSeq: 0,
        pendingCut: null,
        segments: [],
      });
    });
  });

  describe('firstAvailableOffset', () => {
    it('is liveBaseOffset when no segments (boundary: zero segments)', () => {
      const m = createInitialManifest(1);
      m.liveBaseOffset = 4096;
      expect(firstAvailableOffset(m)).toBe(4096);
    });

    it("is the first segment's startOffset when segments exist", () => {
      const m: WorkerOutputManifest = {
        version: 1,
        epoch: 1,
        liveBaseOffset: 200,
        nextSeq: 2,
        pendingCut: null,
        segments: [
          { seq: 0, startOffset: 50, endOffset: 100, bytes: 50, gzBytes: 10, file: 'w-1.seg-0.log.gz' },
          { seq: 1, startOffset: 100, endOffset: 200, bytes: 100, gzBytes: 20, file: 'w-1.seg-1.log.gz' },
        ],
      };
      expect(firstAvailableOffset(m)).toBe(50);
    });
  });

  describe('path + regex helpers', () => {
    it('manifestPathFor builds the sidecar path', () => {
      expect(manifestPathFor('/out', 's', 'w')).toBe('/out/s/w.segments.json');
    });

    it('segmentFileRegex matches this workerId and captures seq', () => {
      const re = segmentFileRegex('w-1');
      expect(re.test('w-1.seg-0.log.gz')).toBe(true);
      expect(re.exec('w-1.seg-42.log.gz')?.[1]).toBe('42');
      expect(re.test('w-1.log')).toBe(false);
      // Must not match a different worker whose id is a prefix.
      expect(re.test('w-10.seg-0.log.gz')).toBe(false);
    });
  });

  describe('readManifest', () => {
    it('returns null for a missing file', async () => {
      expect(await readManifest(`${DIR}/nope.segments.json`)).toBeNull();
    });

    it('returns null for unparsable JSON (degrade, never throw)', async () => {
      vol.writeFileSync(MANIFEST_PATH, 'not json{{');
      expect(await readManifest(MANIFEST_PATH)).toBeNull();
    });

    it('returns null for structurally-invalid JSON', async () => {
      vol.writeFileSync(MANIFEST_PATH, JSON.stringify({ epoch: 'x', segments: 'no' }));
      expect(await readManifest(MANIFEST_PATH)).toBeNull();
    });

    it('round-trips a valid manifest', async () => {
      const m = createInitialManifest(999);
      m.liveBaseOffset = 10;
      await writeManifestDurable(MANIFEST_PATH, m);
      expect(await readManifest(MANIFEST_PATH)).toEqual(m);
    });
  });

  describe('writeFileDurable', () => {
    it('writes content atomically and leaves no temp file', async () => {
      const target = `${DIR}/w-1.log`;
      await writeFileDurable(target, 'hello');
      expect(vol.readFileSync(target, 'utf-8')).toBe('hello');
      expect(vol.existsSync(`${target}.tmp`)).toBe(false);
    });

    it('fsyncs the temp file AND the containing directory (durability)', async () => {
      // FileHandle.sync is invoked for both the temp file and the directory.
      const syncSpy = spyOn(memfs.promises.FileHandle.prototype, 'sync');
      const target = `${DIR}/w-1.log`;
      await writeFileDurable(target, 'durable');
      // At least two syncs: one for the temp file, one for the directory.
      expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      syncSpy.mockRestore();
    });
  });
});
