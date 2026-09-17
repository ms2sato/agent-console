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
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkerOutputFileManager } from '../worker-output-file.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';

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
      await realPromise;
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
});
