/**
 * Real-fs regression test for the flush-after-shutdown reappearance
 * (Issue #1719): `bufferOutput`'s pending-flush timer must not resurrect a
 * `outputs/<session>/<worker>.log` tree under a home the owning context has
 * already shut down (`flushLocked`'s `mkdir -p` would otherwise recreate it
 * within one `WORKER_OUTPUT_FLUSH_INTERVAL`, ~100ms, of removal).
 *
 * Deliberately imports NO memfs / mock-fs-helper and uses plain
 * `fs/promises` against a real `os.tmpdir()` directory. When this file runs
 * ALONE (`bun test src/lib/__tests__/worker-output-file-shutdown.test.ts`),
 * that `fs/promises` binding is the real filesystem. When it runs as part of
 * the FULL `bun test src/` invocation, an earlier test file may already have
 * installed the process-global memfs substitution (`mock-fs-helper.ts`'s
 * `mock.module('fs/promises', ...)` -- see Issue #1699), and this file's own
 * `fs/promises` import silently resolves to that same in-memory
 * implementation instead of the real one. The property under test here (a
 * pending flush timer + `mkdir -p` inside `flushLocked`) is fs-agnostic, so
 * the pins below hold identically under either backing store. Measured:
 * pairing this file with another explicitly-named test file on the `bun
 * test` command line did NOT activate memfs (bun's load order for
 * explicitly-named files differs from its directory-glob order); running
 * the whole `src/lib/__tests__` directory (which loads an earlier,
 * memfs-installing file first) DID activate it, confirmed via
 * `isMemfsActive()` from `../../__tests__/utils/memfs-detection.js`. Both
 * pins below passed, and both of their named mutations failed, under that
 * memfs-active directory run as well as when this file is run alone.
 *
 * Pins P1, P2, and P3 (Issue #1730) extend this file to cover the
 * retain-and-report contract added to `shutdown()`'s underlying flush: a
 * pre-commit I/O failure retains the bytes and reports them (P1), a
 * post-commit failure never requeues them (P2), and the recurring
 * timer/threshold flush path stays best-effort (drop-on-failure) throughout,
 * unaffected by the new retain mode (P3).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import type { WorkerOutputManifest } from '../worker-output-manifest.js';

const FLUSH_INTERVAL_MS = 20;

describe('WorkerOutputFileManager shutdown (real fs, Issue #1719)', () => {
  let home: string;
  let resolver: SessionDataPathResolver;
  let manager: WorkerOutputFileManager;

  beforeEach(async () => {
    // `os.tmpdir()` always exists on the real filesystem, but the memfs
    // substitution (when active) starts from an EMPTY volume with no `/tmp`
    // entry at all -- `fs.mkdtemp` requires its parent to already exist, so a
    // bare `fs.mkdtemp(os.tmpdir())` call fails under memfs even though the
    // property under test has nothing to do with tmp-dir provisioning. The
    // recursive `mkdir` below is a no-op on the real fs and a one-time
    // directory creation under memfs -- fs-agnostic either way.
    const tmpBase = os.tmpdir();
    await fs.mkdir(tmpBase, { recursive: true });
    home = await fs.mkdtemp(path.join(tmpBase, 'ac-worker-output-shutdown-'));
    resolver = new SessionDataPathResolver(`${home}/_quick`);
    manager = new WorkerOutputFileManager({ flushInterval: FLUSH_INTERVAL_MS });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  // Pin A: shutdown() flushes already-buffered data durably before returning.
  //
  // Mutation measured: removing the `await this.flushAll();` line from
  // `shutdown()` (keeping only `this.closed = true;`) -> this test fails
  // (the file is never written, `fs.readFile` rejects ENOENT); restored ->
  // passes. Measured both alone (real fs) and under the memfs-substituted
  // directory run: same result.
  it('flushes buffered output durably before shutdown resolves', async () => {
    manager.bufferOutput('session-a', 'worker-a', 'flushed on shutdown', resolver);

    await manager.shutdown();

    const filePath = manager.getOutputFilePath('session-a', 'worker-a', resolver);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('flushed on shutdown');
  });

  // Pin B: the Issue's exact reproduction shape, and the polarity for the
  // close latch specifically. A second `bufferOutput` call AFTER shutdown is
  // what makes this pin load-bearing -- without it, Pin A's flush alone
  // would already satisfy an assertion that the file exists, and a manager
  // that never closes (only flushes) would still pass.
  //
  // Mutation measured: removing `this.closed = true;` from `shutdown()`
  // (keeping the `flushAll()` call) -> this test fails (the post-shutdown
  // `bufferOutput` call schedules a real timer, which fires and recreates
  // the removed `outputs/` tree); restored -> passes. Pin A passes under
  // this same mutation (its own assertion never calls `bufferOutput` again
  // after shutdown), which is why the two pins are separate tests rather
  // than one. Measured both alone (real fs) and under the
  // memfs-substituted directory run: same result.
  it('does not resurrect the outputs tree when bufferOutput is called after shutdown + removal', async () => {
    manager.bufferOutput('session-b', 'worker-b', 'first write', resolver);
    await manager.shutdown();

    // Remove the whole home, simulating the owning context's data root going
    // away (e.g. a `_quick` delegate session torn down).
    await fs.rm(home, { recursive: true, force: true });

    // The call that would resurrect the tree under the old (pre-#1719)
    // behavior: bufferOutput schedules a timer whose flushLocked does
    // `mkdir -p` unconditionally.
    manager.bufferOutput('session-b', 'worker-b', 'dropped after shutdown', resolver);

    // Wait well past the flush interval -- long enough for the pre-fix timer
    // to have fired and recreated the directory, if the latch were absent.
    await new Promise((resolveTimer) => setTimeout(resolveTimer, FLUSH_INTERVAL_MS * 3));

    const outputsDir = resolver.getOutputsDir();
    await expect(fs.stat(outputsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Pin D: the ordering hole between `this.closed = true` and `await
  // this.flushAll()` inside `shutdown()` (Architect review, PR #1728). A
  // `bufferOutput` call arriving WHILE `flushAll()` is still in flight must
  // see the already-flipped `closed` latch and be dropped, not buffered and
  // timer-scheduled -- because `flushLocked` never consults `closed`, a
  // timer scheduled behind the flush would run to completion regardless of
  // shutdown having since finished, resurrecting the tree.
  //
  // Uses its own manager with a LONGER flush interval than Pin A/B's 20ms.
  // The mutation below reproduces the hole by scheduling a real timer for
  // the interleaved call; that timer fires one interval after the call, and
  // with a 20ms interval the real flush-plus-home-removal sequence in this
  // test could plausibly take longer than that, letting the timer land
  // while `home` still exists and be removed along with it -- a flaky
  // detection either way. 200ms makes the pre-fix timer reliably outlive
  // the removal below, so the mutation's failure is deterministic.
  it('drops a bufferOutput call that arrives while flushAll is still in flight', async () => {
    const pinDManager = new WorkerOutputFileManager({ flushInterval: 200 });

    let resolveDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveDeferred = resolve;
    });

    // Captured BEFORE spying, so calling it below still runs the real
    // implementation -- the mock only wraps timing around it.
    const real = pinDManager.flushAll.bind(pinDManager);
    const flushAllSpy = spyOn(pinDManager, 'flushAll').mockImplementation(async () => {
      // Call through FIRST so the real flushAll's synchronous key snapshot
      // (the `for (const key of this.pendingFlushes.keys())` loop) happens
      // immediately, exactly as it would unmocked -- only the RETURN of
      // this call is delayed, not its start.
      const realPromise = real();
      await deferred;
      return realPromise;
    });

    try {
      pinDManager.bufferOutput('session-d', 'worker-d1', 'first key', resolver);

      const shutdownPromise = pinDManager.shutdown();

      // Interleaved: arrives while the mocked flushAll above is paused on
      // `deferred` -- i.e. after the fix's `this.closed = true` has already
      // run (synchronously, before shutdown()'s first await) but before
      // flushAll has returned.
      pinDManager.bufferOutput('session-d', 'worker-d2', 'second key', resolver);

      resolveDeferred();
      await shutdownPromise;

      await fs.rm(home, { recursive: true, force: true });

      // Mutation measured: restoring the old order (`await this.flushAll();`
      // before `this.closed = true;`) means `this.closed` is still `false`
      // when the interleaved `bufferOutput` call above runs, so it buffers
      // the second key's data and schedules a real timer; that timer fires
      // ~200ms later regardless of `closed` flipping afterward (`flushLocked`
      // never consults it), recreating the outputs tree after the removal
      // above -> `droppedAfterShutdownCount` is 0 AND the dir reappears ->
      // this test fails. Restored (closed-first) -> passes. Measured both
      // alone (real fs, `bun test
      // src/lib/__tests__/worker-output-file-shutdown.test.ts`) and under
      // the memfs-substituted directory run (`bun test src/lib/__tests__`
      // from packages/server): same result in both.
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 600));

      const outputsDir = resolver.getOutputsDir();
      await expect(fs.stat(outputsDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(pinDManager.droppedAfterShutdownCount).toBe(1);
    } finally {
      flushAllSpy.mockRestore();
    }
  });

  // Pin P1 (Issue #1730): a PRE-COMMIT flush failure at shutdown retains the
  // bytes in memory (rather than dropping them) and reports the failure via
  // `shutdown()`'s returned `{ failures }`. Forces the failure by blocking
  // the worker's directory with a regular file at the exact path
  // `flushLocked`'s `mkdir -p` needs, so the mkdir fails before any append --
  // i.e. before the durable commit point.
  //
  // Mutation measured: (i) removing the `pending.buffer = dataToWrite +
  // pending.buffer;` restore line from `flushLocked`'s `retain` branch -->
  // the second flush below writes nothing (file stays absent) --> fails;
  // restored --> passes. (ii) removing the outcome-collection loop in
  // `flushAll` (so `failures` stays `[]` regardless of what `flushBuffer`
  // resolves) --> the `r.failures` assertions below fail (P2's do too, for
  // the same reason); restored --> passes. (iii) reverting
  // `retainedBytes: Buffer.byteLength(dataToWrite, 'utf8')` back to
  // `dataToWrite.length` (UTF-16 code units) --> `data` below contains
  // multibyte characters whose UTF-8 byte length differs from its `.length`,
  // so the `retainedBytes` assertion fails; restored --> passes. All three
  // measured alone (real fs, `bun test
  // src/lib/__tests__/worker-output-file-shutdown.test.ts`) and under the
  // memfs-substituted directory run (`bun test src/lib/__tests__` from
  // packages/server): 1 fail / 2 fail / 1 fail respectively in both.
  it('P1: pre-commit flush failure at shutdown retains the bytes and reports them', async () => {
    const sessionId = 'session-p1';
    const workerId = 'worker-p1';
    // Three CJK characters (escaped so the file stays ASCII) make the UTF-8
    // byte length diverge from the UTF-16 `.length` -- without them the
    // `retainedBytes` assertion could not tell the two apart.
    const data = 'retained on pre-commit failure -- \u65e5\u672c\u8a9e';
    expect(Buffer.byteLength(data, 'utf8')).not.toBe(data.length);

    await fs.mkdir(resolver.getOutputsDir(), { recursive: true });
    const blocker = path.join(resolver.getOutputsDir(), sessionId);
    await fs.writeFile(blocker, '');

    manager.bufferOutput(sessionId, workerId, data, resolver);

    const r = await manager.shutdown();
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ sessionId, workerId, phase: 'pre-commit', retainedBytes: Buffer.byteLength(data, 'utf8') });

    // Unblock and flush again. `manager` is `closed` after `shutdown()`, but
    // `flushAll()` does not consult `closed` (only `bufferOutput` does), so
    // this second, best-effort-default flush still runs and durably writes
    // the bytes `shutdown()` had retained in memory.
    await fs.unlink(blocker);
    await manager.flushAll();

    const filePath = manager.getOutputFilePath(sessionId, workerId, resolver);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe(data);
  });

  // Pin P2 (Issue #1730): a POST-COMMIT flush failure never requeues the
  // buffered bytes, regardless of `mode` -- they are already durably on
  // disk, so requeuing would duplicate them on the next flush. Forces the
  // failure by making `cutSegment` (the step that runs strictly after the
  // durable append, when the live file exceeds `fileMaxSize`) throw.
  //
  // Mutation measured: moving `committed = true` from directly after the
  // `fs.appendFile` to after the `cutSegment` call (so the forced throw is
  // classified pre-commit and, in `retain` mode, the bytes are requeued)
  // --> `phase` reads `'pre-commit'` and the second flush appends `data`
  // again (`data + data`) --> fails; the alternative mutation, dropping the
  // `!committed &&` guard so `retain` mode requeues unconditionally --> the
  // same duplicate --> fails. Restored --> passes. Both measured alone
  // (real fs, `bun test src/lib/__tests__/worker-output-file-shutdown.test.ts`)
  // and under the memfs-substituted directory run (`bun test
  // src/lib/__tests__` from packages/server): same result in both.
  //
  // Seam attempted first, and rejected: a directory pre-created at the exact
  // first-cut segment path (`${workerId}.seg-0.log.gz`), so `cutSegment`'s
  // `writeFileDurable(segPath, gz)` fails its `fs.rename(tmpPath, segPath)`
  // step onto an existing directory (EISDIR/ENOTDIR on the real fs) strictly
  // AFTER the append has already committed, with no access to anything
  // private. Measured: it fails deterministically when this file runs ALONE
  // (real fs), but under the memfs-substituted directory run (`bun test
  // src/lib/__tests__`) memfs's `rename` does not reject a file renamed onto
  // a directory the way the real fs does, so `cutSegment` completes without
  // error and `r.failures` comes back empty. Per this suite's own "must fail
  // deterministically under BOTH invocations" bar, the fs seam is not
  // viable; the private-method spy below is used instead.
  //
  // Spying on the private method: the cast is the single-step intersection
  // this suite already uses for private seams (`WithArchiveWalk` /
  // `WithDecompress` in `worker-output-file-display-fill.test.ts`), never a
  // cast through `unknown`. `mockRejectedValue` rather than
  // `mockImplementation`: bun-types resolves `Mock<T>`'s `mockImplementation`
  // parameter to `never` for a member reached through such an intersection
  // (measured: TS2345 with both a `never[]` rest signature and the real
  // parameter list), while `mockRejectedValue(value: unknown)` is
  // T-independent. A rejected promise surfaces at `await this.cutSegment(...)`
  // exactly like a throw would.
  it('P2: post-commit flush failure does not requeue or duplicate the already-committed bytes', async () => {
    const sessionId = 'session-p2';
    const workerId = 'worker-p2';
    const data = 'committed once, not duplicated';

    // fileMaxSize: 1 so the size check after every append always exceeds it,
    // guaranteeing `cutSegment` runs on the very first flush.
    const p2 = new WorkerOutputFileManager({ flushInterval: FLUSH_INTERVAL_MS, fileMaxSize: 1 });

    type WithCutSegment = WorkerOutputFileManager & {
      cutSegment: (sessionId: string, workerId: string, resolver: SessionDataPathResolver, manifest: WorkerOutputManifest) => Promise<void>;
    };
    const cutSpy = spyOn(p2 as WithCutSegment, 'cutSegment').mockRejectedValue(new Error('cutSegment forced failure (P2)'));

    try {
      p2.bufferOutput(sessionId, workerId, data, resolver);

      const r = await p2.shutdown();
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]).toMatchObject({ sessionId, workerId, phase: 'post-commit', retainedBytes: 0 });

      cutSpy.mockRestore();

      // A second flush finds nothing pending (the failed bytes were never
      // requeued) so it does nothing; the file still holds `data` exactly
      // once from the original, already-committed append. With
      // `fileMaxSize: 1` the real `cutSegment` would run again here if there
      // were pending bytes to flush -- there are none, so it does not. A
      // `.tmp` file from the failed durable write is not produced by this
      // seam (the spy rejects before `writeFileDurable` runs), so there is
      // nothing to clean up here, unlike the rejected directory seam above.
      await p2.flushAll();

      const filePath = p2.getOutputFilePath(sessionId, workerId, resolver);
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe(data);
    } finally {
      cutSpy.mockRestore();
    }
  });

  // Pin P3 (Issue #1730): the recurring interval flush path stays
  // best-effort (drop-on-failure), unaffected by `shutdown()`'s new retain
  // mode -- ruling 3 ("best-effort stays best-effort" for every caller other
  // than `shutdown()`) stays honest under this same failure shape as P1.
  //
  // Mutation measured: passing `'retain'` instead of `'best-effort'` from
  // the timer path's `flushBuffer` call in `bufferOutput` --> the bytes
  // survive the timer's failed flush and the file reappears after the
  // second, unblocked flush below --> this test fails (`fs.stat` resolves
  // instead of rejecting). Restored --> passes. Measured alone (real fs)
  // and under the memfs-substituted directory run: same result.
  it('P3: the interval flush path drops on failure (best-effort, unchanged by #1730)', async () => {
    const sessionId = 'session-p3';
    const workerId = 'worker-p3';
    const data = 'dropped by the interval flush';

    await fs.mkdir(resolver.getOutputsDir(), { recursive: true });
    const blocker = path.join(resolver.getOutputsDir(), sessionId);
    await fs.writeFile(blocker, '');

    manager.bufferOutput(sessionId, workerId, data, resolver);

    // Let the interval timer's best-effort flush fire and fail (dropping the
    // data) before shutdown or any explicit flush is called.
    await new Promise((resolveTimer) => setTimeout(resolveTimer, FLUSH_INTERVAL_MS * 3));

    await fs.unlink(blocker);
    await manager.flushAll();

    const filePath = manager.getOutputFilePath(sessionId, workerId, resolver);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
