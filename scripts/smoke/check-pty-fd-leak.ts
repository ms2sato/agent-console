#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the Bun.Terminal master-fd leak (Issue #1196).
 *
 * `bunTerminalProvider` (the default `PTY_PROVIDER`, see
 * `serverConfig.PTY_PROVIDER`) wraps `Bun.spawn({ terminal: ... })`. The
 * returned `Bun.Terminal` handle owns the PTY master fd (`/dev/ptmx`). Bun's
 * native binding appears to have a GC finalizer that CAN release the fd once
 * the JS wrapper becomes unreachable, but production `InternalPtyWorker.pty`
 * objects stay reachable (referenced via session/worker maps) for a
 * worker's whole lifetime, so incidental GC is not a reliable release path
 * -- only an explicit `Bun.Terminal.close()` call deterministically
 * reclaims it. `BunTerminalPtyAdapter.dispose()` is the production fix,
 * wired into the adapter's `subprocess.exited`-triggered `fireExit()` and
 * called as a backstop from `WorkerManager.detachPty`.
 *
 * This script imports `bunTerminalProvider` directly from production source
 * (no reimplementation) and runs a real spawn/kill cycle against the actual
 * OS repeatedly, observing both:
 *   - this process's own ptmx-fd count (`/proc/<pid>/fd`, counted via a
 *     spawned child process reading `/proc` -- see `countPtmxFds()`)
 *   - `/proc/sys/kernel/pty/nr` -- the kernel-wide allocated-pty counter,
 *     which independently corroborates the per-process fd count (a leak
 *     that somehow bypassed our fd count would still show up here, since
 *     it is a kernel-side resource, not a process-side accounting artifact)
 *
 * IMPORTANT -- every spawned adapter is retained in `retained` for the
 * script's lifetime rather than left to go out of scope per-cycle. Bun's
 * native `Bun.Terminal` binding appears to release the fd via a GC finalizer
 * once its JS wrapper becomes unreachable, independent of the explicit
 * `dispose()` fix under test -- confirmed by a standalone probe during this
 * script's own development: with no retained references, the fd count could
 * still converge to baseline even with `dispose()` disabled, because
 * incidental GC finalized the unreachable adapters. Retaining every adapter
 * keeps them reachable so the ONLY release path is `dispose()`, mirroring
 * production (`InternalPtyWorker.pty` holds a live reference until
 * `detachPty` runs).
 *
 * A short bounded poll is layered on top for the final measurement: killing
 * via signal has an observed small asynchronous tail between
 * `Bun.Terminal.close()` returning and the kernel actually releasing the fd
 * (a handful of fds transiently linger for well under a second across 100
 * cycles in manual probing). Polling is safe here specifically because
 * retained references rule out the GC-masking failure mode above -- without
 * `dispose()`, the same poll never converges.
 *
 * What this smoke does NOT exercise:
 *   - `bunPtyProvider` (the native bun-pty library, `PTY_PROVIDER=bun-pty`).
 *     That provider has a similar-shaped leak on natural process exit, but
 *     rather than a standalone fix, `bun-pty` itself is slated for full
 *     removal (Issue #828), which deletes the leaky code path entirely --
 *     out of scope here.
 *
 * Usage:
 *   bun scripts/smoke/check-pty-fd-leak.ts
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (details on stderr)
 *   2  bad usage / cannot run (e.g. not on Linux -- /proc is unavailable)
 */

import { readFileSync } from 'node:fs';
import { bunTerminalProvider, type PtyInstance } from '../../packages/server/src/lib/pty-provider.js';

if (process.platform !== 'linux') {
  console.error('This smoke depends on /proc (Linux-only). Skipping on', process.platform);
  process.exit(2);
}

const CYCLE_COUNT = 100;

// Counts via a spawned child process reading `/proc/<pid>/fd` (a same-user
// child can read its parent's fd table, the same mechanism `lsof` relies on
// for same-user processes without root). `Bun.spawnSync` is a native Bun API
// unaffected by any `node:fs` mocking elsewhere in the process.
function countPtmxFds(pid: number = process.pid): number {
  const script = `for fd in /proc/${pid}/fd/*; do readlink "$fd" 2>/dev/null; done | grep -c '^/dev/ptmx$'`;
  const result = Bun.spawnSync(['sh', '-c', script]);
  const parsed = Number.parseInt(result.stdout.toString().trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readKernelPtyCount(): number {
  const raw = readFileSync('/proc/sys/kernel/pty/nr', 'utf8').trim();
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.error(`Could not parse /proc/sys/kernel/pty/nr contents: '${raw}'`);
    process.exit(2);
  }
  return parsed;
}

/**
 * Prove countPtmxFds() can actually detect a live ptmx fd before trusting it
 * for the regression assertions below. If the counting mechanism itself is
 * broken (sh missing, /proc unreadable, readlink absent), before/after would
 * both silently read 0 and the assertions below would vacuously pass without
 * verifying anything (Issue #1200).
 */
async function selfCheck(baseline: number): Promise<void> {
  const pty = bunTerminalProvider.spawn('sleep', ['5'], {});
  const exited = new Promise<void>((resolve) => {
    pty.onExit(() => resolve());
  });
  const count = countPtmxFds();
  pty.kill('SIGTERM');
  await exited;
  if (!(count > baseline)) {
    console.error(
      `Self-check failed: countPtmxFds() reported ${count} with a live PTY held open (baseline=${baseline}) -- counting infrastructure is broken, cannot verify`,
    );
    process.exit(2);
  }
}

async function runCycle(retained: PtyInstance[]): Promise<void> {
  const pty = bunTerminalProvider.spawn('sleep', ['3'], {});
  retained.push(pty);
  const exited = new Promise<void>((resolve) => {
    pty.onExit(() => resolve());
  });
  pty.kill('SIGTERM');
  await exited;
}

/**
 * Poll `read()` until `isDone(value)` or `timeoutMs` elapses, returning the
 * last observed value either way. See the file header for why this is safe
 * to pair with retained strong references (it does not reintroduce the
 * GC-masking failure mode).
 */
async function waitUntil<T>(read: () => T, isDone: (value: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  let value = read();
  while (!isDone(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = read();
  }
  return value;
}

const beforeFds = countPtmxFds();
const beforeKernelCount = readKernelPtyCount();

await selfCheck(beforeFds);

// Retained for the assertion's lifetime -- see file header. Without this, an
// unreachable adapter can be GC-finalized mid-run, masking a regression.
const retained: PtyInstance[] = [];
for (let i = 0; i < CYCLE_COUNT; i++) {
  await runCycle(retained);
}

const afterFds = await waitUntil(countPtmxFds, (v) => v <= beforeFds);
const afterKernelCount = await waitUntil(readKernelPtyCount, (v) => v <= beforeKernelCount);

const failures: string[] = [];
let passes = 0;
const expect = (cond: boolean, label: string, detail?: string) => {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
};

console.log(`==> ran ${CYCLE_COUNT} spawn/kill cycles via bunTerminalProvider`);
console.log('==> ptmx fd count (this process, via /proc/<pid>/fd)');
expect(
  afterFds <= beforeFds,
  `ptmx fd count non-increasing (before=${beforeFds}, after=${afterFds})`,
  `before=${beforeFds} after=${afterFds}`,
);

console.log('==> kernel pty counter (/proc/sys/kernel/pty/nr)');
expect(
  afterKernelCount <= beforeKernelCount,
  `kernel pty counter non-increasing (before=${beforeKernelCount}, after=${afterKernelCount})`,
  `before=${beforeKernelCount} after=${afterKernelCount} -- if other processes are actively spawning PTYs on this host, this system-wide counter can rise independently of this script's own leak-freedom -- check for concurrent PTY activity before concluding this is a regression`,
);

console.log();
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log(`PASSED: ${passes} assertion(s) passed`);
process.exit(0);
