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
 * Linux-only: relies on `/proc/self/fd` + `/dev/ptmx`, unavailable on darwin.
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
 * Full-suite caveat: counting ptmx fds requires `node:fs`'s `readdirSync` /
 * `readlinkSync` in-process (there is no way to inspect THIS process's own
 * open fds from a spawned child). Several other test files in this package
 * call `mock.module('node:fs', ...)` (memfs) at import time, which is
 * process-global and irreversible in bun:test (see
 * `.claude/rules/testing.md` "Module-Level Mocking" anti-pattern and
 * `workers-upload-dir-real-fs.test.ts` for the same constraint applied to a
 * different real-fs contract). When memfs is active, `/proc/self/fd` is not
 * populated, so this suite skips itself with a note rather than failing
 * against the in-memory simulation. Run this file alone to exercise the real
 * assertions:
 *
 *   bun test packages/server/src/lib/__tests__/pty-provider-fd-leak.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readlinkSync } from 'node:fs';
import { bunTerminalProvider, type PtyInstance } from '../pty-provider.js';
import { isMemfsActive } from '../../__tests__/utils/memfs-detection.js';
import type { IExitEvent } from 'bun-pty';

function countPtmxFds(): number {
  let count = 0;
  for (const entry of readdirSync('/proc/self/fd')) {
    try {
      if (readlinkSync(`/proc/self/fd/${entry}`) === '/dev/ptmx') count++;
    } catch {
      // fd closed between readdir and readlink; ignore.
    }
  }
  return count;
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
    if (await isMemfsActive()) {
      console.log(
        '[skip] memfs is active in this process; /proc/self/fd is not populated. Run this file alone (`bun test pty-provider-fd-leak.test.ts`) to exercise the real assertion.',
      );
      return;
    }

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
    if (await isMemfsActive()) {
      console.log(
        '[skip] memfs is active in this process; /proc/self/fd is not populated. Run this file alone (`bun test pty-provider-fd-leak.test.ts`) to exercise the real assertion.',
      );
      return;
    }

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
