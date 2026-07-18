/**
 * Real-fd regression test for the Bun.Terminal master-fd leak (Issue #1196).
 *
 * `bunTerminalProvider` wraps `Bun.spawn({ terminal: ... })`, which allocates
 * a PTY master fd (`/dev/ptmx`) via `Bun.Terminal`. `BunTerminalPtyAdapter`
 * did not release it on exit; `dispose()` (wired into the adapter's
 * `fireExit()`) is the fix under test here.
 *
 * This file imports `bunTerminalProvider` directly (production code, no
 * reimplementation) and spawns REAL processes -- it does not use the mocked
 * `Bun.spawn` harness in `pty-provider.test.ts`, and must not run inside that
 * mock's `beforeEach`/`afterEach` (kept in a separate file to guarantee
 * that).
 *
 * Linux-only: relies on `/proc/<pid>/fd` + `/dev/ptmx`, unavailable on darwin.
 *
 * IMPORTANT -- strong references are retained deliberately. Bun's native
 * `Bun.Terminal` binding appears to release the fd via a GC finalizer once
 * the JS wrapper object becomes unreachable, independent of this file's
 * explicit `dispose()` fix (confirmed via a standalone probe: without
 * retained references, the fd count converged to baseline even with the fix
 * temporarily disabled, because the loop-scoped `pty` variables became
 * GC-eligible and were finalized mid-test). Retaining every spawned adapter
 * in `retained` for the duration of the assertion keeps them reachable, so
 * the ONLY path that can release the fd is the explicit `dispose()` call --
 * exactly mirroring the production shape (`InternalPtyWorker.pty` holds a
 * live reference until `detachPty` runs). Without this, the test would
 * pass/fail based on incidental GC timing rather than the fix.
 *
 * A short bounded poll (`waitForPtmxCount`) is layered on top of the
 * retained-references technique for the kill() path specifically: killing
 * via signal has an observed small asynchronous tail between
 * `Bun.Terminal.close()` returning and the kernel actually releasing the fd
 * (a handful of fds transiently linger for well under a second across 100
 * cycles in manual probing). This is safe to poll for precisely because
 * retained references rule out the GC-masking failure mode above -- with no
 * `dispose()` call, polling the same way never converges (confirmed: stuck
 * at the fully-leaked count even after 2+ seconds of polling with strong
 * references held), so the bounded wait absorbs only the real completion
 * lag, not a missing fix.
 *
 * memfs-immunity: several other test files in this package call
 * `mock.module('node:fs', ...)` (memfs) at import time, which is
 * process-global and irreversible for the remainder of the `bun:test`
 * process (see `.claude/rules/testing.md` "Module-Level Mocking"
 * anti-pattern and `workers-upload-dir-real-fs.test.ts` for the same
 * constraint applied to a different real-fs contract). An earlier version of
 * this file counted ptmx fds via in-process `node:fs` calls
 * (`readdirSync`/`readlinkSync`), which meant the assertions silently no-op'd
 * under `bun run test` once memfs was active. `countPtmxFds()` now spawns a
 * child process (`Bun.spawnSync`, a native Bun API unaffected by
 * `mock.module('node:fs', ...)`) that reads `/proc/<pid>/fd` directly from
 * the OS -- a same-user child process can read its parent's `/proc/<pid>/fd`
 * entries (the same mechanism that lets `lsof` inspect another process
 * owned by the same user without root). This makes the assertions run for
 * real regardless of which other test files ran first in the same process.
 *
 * cross-test GC noise: fixing the above surfaced a second, narrower issue --
 * each `it()` block below force-collects (`Bun.gc(true)`) before capturing
 * its baseline, to flush any already-unreachable `Bun.Terminal` garbage left
 * over from OTHER test files' real PTY spawns in this same process. Without
 * it, that unrelated garbage could get finalized during THIS test's polling
 * window and mask a real regression here (a full-suite run produced a false
 * pass on the kill()-path test with `dispose()` disabled, while the same
 * test failed correctly when run in isolation). See each test body for the
 * inline rationale.
 */
import { describe, it, expect } from 'bun:test';
import { bunTerminalProvider, type PtyInstance } from '../pty-provider.js';
import type { IExitEvent } from 'bun-pty';

function countPtmxFds(pid: number = process.pid): number {
  const script = `for fd in /proc/${pid}/fd/*; do readlink "$fd" 2>/dev/null; done | grep -c '^/dev/ptmx$'`;
  const result = Bun.spawnSync(['sh', '-c', script]);
  const parsed = Number.parseInt(result.stdout.toString().trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function waitForExit(pty: PtyInstance): Promise<IExitEvent> {
  return new Promise((resolve) => {
    pty.onExit((event) => resolve(event));
  });
}

/**
 * Poll `countPtmxFds()` until it reaches `expected` or `timeoutMs` elapses.
 * See the file header for why this is safe to pair with retained strong
 * references (it does not reintroduce the GC-masking failure mode).
 */
async function waitForPtmxCount(expected: number, timeoutMs = 2000): Promise<number> {
  const start = Date.now();
  let count = countPtmxFds();
  while (count !== expected && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    count = countPtmxFds();
  }
  return count;
}

describe.skipIf(process.platform !== 'linux')('bunTerminalProvider ptmx fd leak regression (Issue #1196)', () => {
  const SPAWN_COUNT = 10;

  it('natural exit: ptmx fd count returns to baseline after N short-lived spawns', async () => {
    // Force-collect any already-unreachable Bun.Terminal objects left over
    // from OTHER test files' PTY spawns in this same bun:test process before
    // taking the baseline. Without this, incidental GC of unrelated tests'
    // garbage during this test's polling window can mask a real regression
    // (confirmed: with `dispose()` disabled, a full-suite run produced a
    // false pass on this test's sibling below, while an isolated-file run of
    // the same test correctly failed) -- a cross-test variant of the
    // GC-masking problem the `retained` array already guards against within
    // a single test.
    Bun.gc(true);
    const baseline = countPtmxFds();
    // Retained for the assertion's lifetime -- see file header. Without this,
    // GC can finalize a spawned-and-out-of-scope adapter and release its fd
    // on its own, independent of dispose(), masking a regression.
    const retained: PtyInstance[] = [];

    for (let i = 0; i < SPAWN_COUNT; i++) {
      const pty = bunTerminalProvider.spawn('true', [], {});
      retained.push(pty);
      await waitForExit(pty);
    }

    expect(await waitForPtmxCount(baseline)).toBe(baseline);
    expect(retained.length).toBe(SPAWN_COUNT);
  });

  it('kill() path: ptmx fd count returns to baseline after N kill()-then-exit cycles', async () => {
    // See the sibling test above for why this force-collect is needed.
    Bun.gc(true);
    const baseline = countPtmxFds();
    const retained: PtyInstance[] = [];

    for (let i = 0; i < SPAWN_COUNT; i++) {
      const pty = bunTerminalProvider.spawn('sleep', ['5'], {});
      retained.push(pty);
      const exited = waitForExit(pty);
      pty.kill('SIGTERM');
      await exited;
    }

    expect(await waitForPtmxCount(baseline)).toBe(baseline);
    expect(retained.length).toBe(SPAWN_COUNT);
  });
});
