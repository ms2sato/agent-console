#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the stdin-sink fd leak fixed in Issue #1230.
 *
 * Long-lived `spawnAsUser` consumers that feed a subprocess's stdin over its
 * lifetime (`InteractiveProcessManager`, `EmbeddedAgentWorkerService`) must
 * close the returned `FileSink` explicitly at teardown, or the underlying
 * pipe write-end fd is left for incidental GC -- the same unsound pattern
 * Issue #1196 established as unacceptable for the PTY master-fd handle
 * (`check-pty-fd-leak.ts` is the sibling smoke for that fix).
 * `endStdinSafely` (a private helper duplicated in each consumer, per
 * `.claude/rules/elevation-helpers.md`'s "feeding-consumer teardown
 * obligation") is the production fix.
 *
 * This script imports the PRODUCTION `InteractiveProcessManager` directly
 * (no reimplementation) and drives real spawn/kill cycles through its public
 * `runProcess` / `killProcess` API against the actual OS, using the DEFAULT
 * (real, non-elevated-bypass) `spawnAsUser` -- no fake is injected for the
 * spawn shape itself, so `sh -c <command>` is spawned for real via
 * `Bun.spawn`. A thin recording wrapper around `spawnAsUser` is passed via
 * `InteractiveProcessManager`'s existing `spawnAsUserFn` DI param solely so
 * this script can reach the raw subprocess handles for final SIGKILL
 * cleanup (see "Test command shape" below) -- it does not alter spawn
 * behavior.
 *
 * Coverage note: only `InteractiveProcessManager` is exercised here.
 * `EmbeddedAgentWorkerService` needs session/DB scaffolding that isn't worth
 * standing up for a filesystem-descriptor smoke; its stdin-sink teardown is
 * covered instead by the unit tests in
 * `packages/server/src/services/__tests__/embedded-agent-worker-service.test.ts`
 * (a deliberate, already-decided substitution -- see Issue #1230).
 *
 * Test command shape -- why the spawned child ignores SIGTERM and never
 * reads stdin:
 * ------------------------------------------------------------------------
 * `killProcess()` always sends `SIGTERM` to the child (unchanged behavior,
 * not part of this fix). Empirically, once a child actually exits and Bun
 * reaps it, Bun's own subprocess-lifecycle cleanup closes ALL of that
 * child's associated pipe fds (stdin/stdout/stderr) on OUR side too --
 * completely independent of whether `stdin.end()` was ever called. Using an
 * ordinary child (e.g. `cat`, which also exits on EOF) therefore makes the
 * pre-fix and post-fix fd counts converge to the same value once the child
 * dies, masking the exact defect this smoke exists to catch (verified
 * empirically while developing this script: a `cat`-based version passed
 * identically with the production fix reverted).
 *
 * To isolate the deterministic `stdin.end()` effect from that confound, the
 * test command (`trap '' TERM; exec sleep <N>`) is deliberately immune to
 * BOTH triggers that would otherwise reap it during the measurement window:
 *   - `trap '' TERM` sets SIGTERM to be ignored, and POSIX preserves an
 *     ignored (SIG_IGN) disposition across `exec`, so the exec'd `sleep`
 *     stays immune -- `killProcess()`'s `kill(15)` cannot terminate it.
 *   - `sleep` never reads stdin, so closing stdin's write end (whether via
 *     the fix or incidentally) has no effect on the child's lifetime either
 *     (unlike `cat`, which would exit on the resulting EOF).
 * The child is therefore still alive when fds are counted after the cycle
 * loop, in BOTH the fixed and unfixed case. Its stdout+stderr pipe fds
 * legitimately stay open the whole time (nothing in this fix touches them);
 * only the stdin fd's fate differs between fixed and unfixed code. The
 * assertion below is bounded accordingly (see EXPECTED_SURVIVING_FDS below)
 * rather than asserting a full return to baseline, and every spawned
 * subprocess is force-killed with SIGKILL (uncatchable) at the end of the
 * script so nothing is left running on the host.
 *
 * IMPORTANT -- unlike `check-pty-fd-leak.ts`, this script does NOT call
 * `Bun.gc()` anywhere. The deterministic-release contract under test here IS
 * "the pipe write-end fd is closed at `killProcess()` call time, with no GC
 * involved" -- forcing (or masking) GC would hide exactly the defect this
 * smoke exists to catch. A short bounded poll after the cycle loop accounts
 * only for the small asynchronous tail between `killProcess()` returning and
 * the kernel reflecting the closed fd (mirrors `check-pty-fd-leak.ts`'s
 * `waitUntil` helper) -- it is not a GC wait, since the test children never
 * exit during the measurement window (see above).
 *
 * GC-timing nondeterminism and why the pre-fix signal is still trustworthy:
 * even with no explicit `Bun.gc()` call, Bun's own incidental garbage
 * collection can still run during the cycle loop (allocation pressure from
 * 50 spawned subprocesses/streams) and may reclaim -- and thus close -- some
 * unfixed (leaked) stdin sinks purely by chance. This means a pre-fix run's
 * fd count is a LOWER BOUND on the true leak, not an exact count: one
 * observed pre-fix run measured `baseline=3, after=129` (delta=126 over 50
 * cycles, ~2.52/cycle) rather than the theoretical maximum of ~153
 * (delta=150, exactly 3/cycle) that zero incidental GC would produce --
 * some leaked sinks were already reclaimed by the time the count ran. This
 * is exactly why `SLACK_FDS` (10) is kept small relative to
 * `CYCLE_COUNT * EXPECTED_SURVIVING_FDS_PER_CYCLE` (50 * 2 = 100): a real
 * per-cycle stdin leak adds up to `CYCLE_COUNT` extra fds (50) even after
 * incidental GC reclaims some of them, which is far larger than the 10-fd
 * slack margin -- so the bounded assertion below still reliably fails on a
 * regression despite this noise. None of this contradicts the "no GC
 * needed" point above: the fixed path's release is unconditional and
 * synchronous at `killProcess()` time regardless of whether GC ever runs;
 * this note only explains why the UNFIXED path's failure signal remains a
 * reliable (if conservative) lower bound even though incidental GC is
 * outside this script's control.
 *
 * Usage:
 *   bun scripts/smoke/check-stdin-sink-leak.ts
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (details on stderr)
 *   2  bad usage / cannot run (e.g. not on Linux -- /proc is unavailable)
 */

import { InteractiveProcessManager } from '../../packages/server/src/services/interactive-process-manager.js';
import { spawnAsUser, type SpawnAsUserResult } from '../../packages/server/src/services/privilege-elevation.js';

if (process.platform !== 'linux') {
  console.error('This smoke depends on /proc (Linux-only). Skipping on', process.platform);
  process.exit(2);
}

const CYCLE_COUNT = 50;
// Immune to SIGTERM (ignored, preserved across exec) and never reads stdin,
// so the child stays alive for the whole measurement window regardless of
// whether the stdin-sink fix is present -- see the file header.
const IMMORTAL_COMMAND = `trap '' TERM; exec sleep 100`;
// The child staying alive means its stdout+stderr pipe fds legitimately stay
// open in BOTH the fixed and unfixed case (nothing in this fix touches
// them) -- only the stdin fd differs. `+1` per cycle of slack absorbs minor
// kernel-side counting jitter without weakening the assertion: an actual
// stdin leak would add a full extra fd per cycle (50), far outside this
// margin.
const EXPECTED_SURVIVING_FDS_PER_CYCLE = 2;
const SLACK_FDS = 10;

// Every subprocess handle spawned during this run, kept ONLY so the script
// can force-kill (SIGKILL, uncatchable) every immortal test child before
// exiting -- not for defeating GC (see file header; the fixed path never
// relies on GC to begin with).
const spawnedSubprocesses: SpawnAsUserResult['subprocess'][] = [];
function recordingSpawnAsUser(opts: Parameters<typeof spawnAsUser>[0]): SpawnAsUserResult {
  const result = spawnAsUser(opts);
  spawnedSubprocesses.push(result.subprocess);
  return result;
}

function killAllSpawned(): void {
  for (const subprocess of spawnedSubprocesses) {
    try {
      subprocess.kill(9);
    } catch {
      // Already gone.
    }
  }
}

// Counts via a spawned child process reading `/proc/<pid>/fd` (a same-user
// child can read its parent's fd table, the same mechanism `lsof` relies on
// for same-user processes without root). `Bun.spawnSync` is a native Bun API
// unaffected by any `node:fs` mocking elsewhere in the process. Mirrors
// `check-pty-fd-leak.ts`'s `countPtmxFds`.
//
// Matches both `pipe:[...]` (anonymous pipes, the typical bare-metal Linux
// shape for `Bun.spawn({ stdio: 'pipe' })`) and `socket:[...]` (some
// container/sandbox runtimes implement stdio piping via `socketpair(2)`
// instead of `pipe(2)` -- verified empirically in this repo's own sandboxed
// dev environment, where every spawned child's 3 stdio fds show up as
// `socket:[N]` rather than `pipe:[N]`).
function countPipeFds(pid: number = process.pid): number {
  const script = `for fd in /proc/${pid}/fd/*; do readlink "$fd" 2>/dev/null; done | grep -cE '^(pipe|socket):'`;
  const result = Bun.spawnSync(['sh', '-c', script]);
  const parsed = Number.parseInt(result.stdout.toString().trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Prove countPipeFds() can actually detect a live pipe fd before trusting it
 * for the regression assertion below. If the counting mechanism itself is
 * broken (sh missing, /proc unreadable, readlink absent), before/after would
 * both silently read 0 and the assertion below would vacuously pass without
 * verifying anything (Issue #1200). Also doubles as the warm-up cycle:
 * `InteractiveProcessManager` logs via pino on every spawn/kill, and pino's
 * transport lazily opens a couple of extra fds the first time it is
 * actually used (a one-time initialization cost, not a per-cycle leak) --
 * running it here, before the real baseline is captured, keeps that cost
 * out of the main loop's measurement.
 */
async function selfCheckAndWarmUp(manager: InteractiveProcessManager, earlyBaseline: number): Promise<void> {
  const info = await manager.runProcess({
    sessionId: 'stdin-leak-smoke-selfcheck',
    workerId: 'w',
    command: IMMORTAL_COMMAND,
  });
  const count = countPipeFds();
  manager.killProcess(info.id);
  if (!(count > earlyBaseline)) {
    console.error(
      `Self-check failed: countPipeFds() reported ${count} with a live subprocess held open (baseline=${earlyBaseline}) -- counting infrastructure is broken, cannot verify`,
    );
    killAllSpawned();
    process.exit(2);
  }
  // Let the kernel settle after the self-check's own kill/close before the
  // real baseline is captured.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function runCycle(manager: InteractiveProcessManager): Promise<void> {
  const info = await manager.runProcess({
    sessionId: 'stdin-leak-smoke',
    workerId: 'w',
    command: IMMORTAL_COMMAND,
  });
  const killed = manager.killProcess(info.id);
  if (!killed) {
    console.error('killProcess unexpectedly returned false mid-run -- cannot verify');
    killAllSpawned();
    process.exit(2);
  }
}

/**
 * Poll `read()` until `isDone(value)` or `timeoutMs` elapses, returning the
 * last observed value either way. This accounts for the small asynchronous
 * tail between `killProcess()` returning and the kernel reflecting the
 * closed stdin fd -- NOT for the test children exiting (they never do, by
 * design -- see file header) and NOT for GC.
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

// Extracted into main() (Issue #1479), order-preserving verbatim move: this
// entire body was top-level, executing as a side effect of merely importing
// this file. Guarded below so only running it as the entry point does.
async function main(): Promise<void> {
  const manager = new InteractiveProcessManager(
    () => {},
    () => {},
    undefined,
    undefined,
    recordingSpawnAsUser,
  );

  const earlyBaseline = countPipeFds();
  await selfCheckAndWarmUp(manager, earlyBaseline);

  const baselineFds = countPipeFds();

  for (let i = 0; i < CYCLE_COUNT; i++) {
    await runCycle(manager);
  }

  const expectedMax = baselineFds + CYCLE_COUNT * EXPECTED_SURVIVING_FDS_PER_CYCLE + SLACK_FDS;
  const afterFds = await waitUntil(countPipeFds, (v) => v <= expectedMax);

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

  console.log(`==> ran ${CYCLE_COUNT} spawn/kill cycles via InteractiveProcessManager.runProcess/killProcess`);
  console.log('==> pipe/socket fd count (this process, via /proc/<pid>/fd)');
  expect(
    afterFds <= expectedMax,
    `fd count bounded by surviving-child stdout+stderr only, no stdin leak (baseline=${baselineFds}, after=${afterFds}, expectedMax=${expectedMax})`,
    `baseline=${baselineFds} after=${afterFds} expectedMax=${expectedMax} (an actual stdin leak would add ~${CYCLE_COUNT} more, one per cycle)`,
  );

  console.log();
  manager.disposeAll();
  killAllSpawned();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

if (import.meta.main) {
  main();
}
