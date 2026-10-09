#!/usr/bin/env bun
/**
 * Measurement instrument for Issue #1879: settle whether
 * `check-exit-127-diagnostic.ts`'s `selfCheck()` flake under host
 * contention ("basic PTY did not exit within timeout") is (i) a lost exit
 * event in the underlying `PtyProvider` (LOST-EXIT -- a real adapter/
 * upstream defect) or (ii) a genuinely stuck child under load (STUCK-CHILD
 * -- an environment fact, not a code defect). See "Provider identity
 * matters" below: which `PtyProvider` the question is about matters.
 *
 * ## Why this is a separate script, not a change to `selfCheck()` itself
 *
 * The Issue's prior capture method (polling `pgrep -P <smoke_pid>` once per
 * second) came back empty on every one of 20 contended runs, including the
 * 18 clean ones -- the gap was in the detection method, not evidence the
 * child was gone. This probe reads the child's exact `pid` directly off the
 * `PtyInstance` bun-pty already returns (`pty.pid`, public, no
 * `pty-provider.ts` change needed) and reads `/proc/<pid>` synchronously the
 * instant the race against `EXIT_WAIT_TIMEOUT_MS` loses, instead of racing a
 * 1-second-granularity external poll against the same clock.
 *
 * ## Provider identity matters -- read before trusting a result
 *
 * `check-exit-127-diagnostic.ts`'s `selfCheck()` hardcodes `bunPtyProvider`
 * (the LEGACY native 'bun-pty' library, slated for removal per Issue #828),
 * not the configured default. Production runs `PTY_PROVIDER=bun-terminal`
 * (`serverConfig.ts`'s default; no systemd override) -- i.e. `bunTerminalProvider`
 * / `BunTerminalPtyAdapter`, a COMPLETELY SEPARATE implementation.
 * `bunPtyProvider.spawn()` is a bare `require('bun-pty').spawn(...)` with no
 * JS-level wrapping in `pty-provider.ts` at all, so a LOST-EXIT measured
 * against it says nothing about `BunTerminalPtyAdapter`'s exit bridge. This
 * probe defaults to `--provider bun-terminal` (production's actual
 * configured default) since #1886 removed the "mirrors selfCheck() exactly"
 * rationale for the old `bun-pty` default -- the probe should measure
 * production unless told otherwise. `--provider bun-pty` remains available
 * as an explicit legacy opt-in, e.g. to reproduce #1879's own recorded
 * bun-pty LOST-EXIT finding (Issue #1888). The SAME code (positive control,
 * classifier, observables) runs against whichever provider is selected.
 *
 * ## What this probe exercises
 *
 *   - The REAL `PtyProvider.spawn(...)` path for the selected `--provider`,
 *     spawning `sh -c 'echo ok'` exactly as `check-exit-127-diagnostic.ts`'s
 *     `selfCheck()` does (with `--provider bun-pty`; the default,
 *     `bun-terminal`, measures production's actually-configured provider
 *     instead).
 *   - On every timeout, four observables read in this exact order (the
 *     Architect's AC rationale: a zombie answers `kill -0` with 0 and would
 *     be misread as "alive" if read before the `/proc/<pid>/stat` state):
 *       1. `/proc/<pid>` existence + `/proc/<pid>/stat` field 3 (state letter)
 *       2. `kill(pid, 0)` result (ESRCH vs 0 vs EPERM)
 *       3. the adapter's own view: whether the exit listener fired. `IPty` /
 *          `PtyInstance` expose no surface onto the underlying `Bun.spawn`
 *          subprocess (and this probe deliberately does NOT add one to
 *          `pty-provider.ts` -- the Architect's AC is explicit about this),
 *          so this observable is `pty.pid` + `/proc` only, same as (1)/(2).
 *       4. `Bun.version`, `os.loadavg()`, and whether `--contend` was active.
 *   - After those four observables, a post-timeout grace window (`--grace-ms`,
 *     default 2000ms) waits for the exit listener to fire late before the
 *     child is killed, recording `exitFiredWithinGrace` and the late-fire
 *     latency -- this is what separates a merely DELAYED exit from one that
 *     is genuinely LOST (Issue #1888).
 *   - A same-run positive control (workflow.md sub-pattern 9): before any
 *     measurement cycle, spawns `sh -c 'sleep 100'`, confirms the SAME
 *     observable code path reports it alive (state `S`, `kill -0` = 0), then
 *     SIGHUPs it and confirms it goes away or zombifies within 1s. A failed
 *     control exits 2 and prints no verdict -- an instrument that cannot see
 *     a live-then-dead process cannot be trusted to report an absence.
 *
 * ## What this probe does NOT do
 *
 *   - Change `check-exit-127-diagnostic.ts`, `pty-provider.ts`, or
 *     `worker-manager.ts`.
 *   - Use `pgrep -P` polling (the Issue records it as the method that saw
 *     nothing) or `bun run test` as a contention source (would collide with
 *     the full-suite slot rule).
 *   - Kill any pid it did not itself spawn in this run.
 *   - Fix anything itself. A LOST-EXIT finding is filed as a separate Issue
 *     (naming `BunTerminalPtyAdapter`'s exit bridge as the first hypothesis
 *     ONLY when the finding is actually against `--provider bun-terminal`
 *     -- a `bun-pty` LOST-EXIT is a different, legacy code path entirely,
 *     see "Provider identity matters" above).
 *
 * Usage:
 *   bun scripts/smoke/probe-pty-exit-observation.ts [--timeout-ms N] [--cycles N] [--contend] [--contend-n N] [--provider bun-pty|bun-terminal] [--grace-ms N]
 *
 *   --timeout-ms N   race timeout per cycle, ms (default 30000, matching
 *                    check-exit-127-diagnostic.ts's EXIT_WAIT_TIMEOUT_MS).
 *                    `--timeout-ms 1 --cycles 1` is the Q12 sanity check:
 *                    forces the timeout path on a healthy child and proves
 *                    the instrument emits a complete observable set.
 *   --cycles N       sequential measurement cycles (default 20).
 *   --contend        spawn --contend-n busy `bun -e` children (CPU spin +
 *                    fork storm) for the duration of the loop, owned and
 *                    SIGKILLed by this probe in a `finally` block. Q13
 *                    proxy: this stands in for "ordinary host contention",
 *                    upstream of and outside the chain under test.
 *   --contend-n N    number of busy children when --contend is set
 *                    (default 4).
 *   --provider P     'bun-terminal' (default -- production's actual
 *                    configured default, BunTerminalPtyAdapter) or
 *                    'bun-pty' (legacy opt-in, the native library
 *                    selfCheck() hardcodes). See "Provider identity
 *                    matters" above before interpreting a bun-pty result
 *                    as saying anything about production.
 *   --grace-ms N     post-timeout observation window before `pty.kill` /
 *                    `dispose`, ms (default 2000; `0` disables, reproducing
 *                    the pre-#1888 behaviour where a late-firing listener
 *                    was indistinguishable from one that never fires).
 *                    Separates DELAYED-EXIT (listener fires within the
 *                    window) from LOST-EXIT (it never does) -- Issue #1888.
 *
 * Exit codes:
 *   0  measured -- every cycle either exited naturally or produced a
 *      definite verdict (LOST-EXIT, DELAYED-EXIT, or STUCK-CHILD),
 *      regardless of which.
 *   1  at least one cycle was INCONCLUSIVE (see classifyTimeout).
 *   2  harness failure -- the positive control failed, bad arguments, or an
 *      unexpected exception anywhere in `main()` (caught at the top level
 *      so an uncaught rejection never falls through to Bun's own default
 *      exit code 1, which this script's own exit-code contract already
 *      means something specific: "at least one INCONCLUSIVE cycle"). No
 *      verdict is printed when this fires: the instrument's own ability to
 *      observe a live-then-dead process was not established.
 *
 * Sync contract: NONE for the classifier -- `classifyTimeout` and
 * `determineExitCode` are pure functions pinned by
 * `scripts/smoke/__tests__/probe-pty-exit-observation.test.ts`, which
 * imports them directly and never spawns a PTY.
 */

import './_env.js';
import * as os from 'os';
import * as fs from 'fs/promises';

import { getPtyProvider, type PtyProvider, type PtyProviderName } from '../../packages/server/src/lib/pty-provider.js';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CYCLES = 20;
const DEFAULT_CONTEND_N = 4;
const DEFAULT_PROVIDER: PtyProviderName = 'bun-terminal';
const DEFAULT_GRACE_MS = 2000;
const POSITIVE_CONTROL_SETTLE_MS = 200;
const POSITIVE_CONTROL_KILL_WAIT_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAsync(pred: () => Promise<boolean>, timeoutMs: number, pollMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await sleep(pollMs);
  }
  return await pred();
}

// ---------------------------------------------------------------------------
// Pure classification (pinned by probe-pty-exit-observation.test.ts)
// ---------------------------------------------------------------------------

export type Verdict = 'LOST-EXIT' | 'DELAYED-EXIT' | 'STUCK-CHILD' | 'INCONCLUSIVE';

export type KillZeroErrno = 'ESRCH' | 'EPERM' | 0;

export interface ClassifyTimeoutInput {
  /** `/proc/<pid>/stat` field 3 (state letter), or `undefined` if `/proc/<pid>` is gone. */
  procState: string | undefined;
  /** `kill(pid, 0)`'s result: 0 = answered (alive or zombie), else the errno. */
  killZeroErrno: KillZeroErrno;
  /** Whether the adapter's own `onExit` listener fired AT the moment the timeout race was lost. */
  exitFired: boolean;
  /** Whether the listener fired LATER, within the post-timeout grace window (Issue #1888). */
  exitFiredWithinGrace: boolean;
}

export interface ClassifyTimeoutResult {
  verdict: Verdict;
  reason?: string;
}

/**
 * Classifies a single cycle's timeout per the Architect's AC (Issue #1888):
 *
 *   DELAYED-EXIT = onExit fired within the post-timeout grace window
 *                  (regardless of procState -- the exit event arrived; the
 *                  pid being gone by the time it is observed is consistent)
 *   LOST-EXIT    = /proc/<pid> absent or state Z AND onExit never fired,
 *                  neither at timeout nor within the grace window
 *   STUCK-CHILD  = state in R/S/D at timeout
 *   INCONCLUSIVE = anything else (named)
 *
 * `exitFired` (fired AT the moment the timeout race was lost) wins over
 * everything else, including `exitFiredWithinGrace`: if the listener fired
 * that early, the race was lost to a timing artefact of THIS probe (the
 * timeout branch and the `onExit` branch both resolved, and `Promise.race`
 * already committed to the timeout side), not to the PTY layer -- so it is
 * never classified as a real absence-of-exit, regardless of what `/proc`
 * says at that instant or what the grace window later observes.
 */
export function classifyTimeout(input: ClassifyTimeoutInput): ClassifyTimeoutResult {
  const { procState, killZeroErrno, exitFired, exitFiredWithinGrace } = input;

  if (exitFired) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'the exit listener fired despite the race reporting a timeout -- a probe timing artefact, not a PTY-layer absence',
    };
  }

  if (exitFiredWithinGrace) {
    return { verdict: 'DELAYED-EXIT' };
  }

  const gone = procState === undefined;
  const zombie = procState === 'Z';
  const running = procState === 'R' || procState === 'S' || procState === 'D';

  if (gone || zombie) {
    // A genuinely gone pid should answer kill(pid, 0) with ESRCH. Disagreement
    // (anything else) is a pid-reuse-shaped inconsistency between the two
    // observables, worth naming rather than silently trusting /proc alone.
    if (gone && killZeroErrno !== 'ESRCH') {
      return {
        verdict: 'INCONCLUSIVE',
        reason: `/proc/<pid> is absent but kill(pid, 0) returned ${String(killZeroErrno)} (expected ESRCH) -- possible pid reuse`,
      };
    }
    return { verdict: 'LOST-EXIT' };
  }

  if (running) {
    return { verdict: 'STUCK-CHILD' };
  }

  return { verdict: 'INCONCLUSIVE', reason: `unexpected /proc/<pid>/stat state letter: ${String(procState)}` };
}

export type CycleSummary = { outcome: 'exited' } | { outcome: 'timeout'; verdict: Verdict };

/**
 * 0 = every cycle is "measured" (exited naturally, or produced ANY definite
 * verdict including LOST-EXIT/DELAYED-EXIT/STUCK-CHILD); 1 = at least one
 * INCONCLUSIVE.
 * The harness-failure exit code (2) is decided before any cycle runs (the
 * positive control, or bad arguments) and is not this function's concern.
 */
export function determineExitCode(cycles: CycleSummary[]): 0 | 1 {
  const hasInconclusive = cycles.some((c) => c.outcome === 'timeout' && c.verdict === 'INCONCLUSIVE');
  return hasInconclusive ? 1 : 0;
}

// ---------------------------------------------------------------------------
// OS-level observables
// ---------------------------------------------------------------------------

/** `/proc/<pid>/stat` field 3 (state letter), or `undefined` if the entry is gone. */
async function readProcState(pid: number): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
    // Field 2 (comm) is parenthesized and may itself contain ')' in rare
    // cases, so anchor on the LAST ')' rather than splitting naively.
    const closeParen = raw.lastIndexOf(')');
    if (closeParen === -1) return undefined;
    const rest = raw.slice(closeParen + 2); // skip ") "
    const state = rest.split(' ')[0];
    return state && state.length > 0 ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `kill(pid, 0)`: 0 if the process answers (alive OR zombie -- a zombie
 * still answers 0, which is exactly why `/proc/<pid>/stat`'s state letter
 * must be read FIRST per the AC's rationale), else the errno. Collapses any
 * errno other than EPERM into ESRCH rather than throwing, so an unexpected
 * OS error never crashes the whole probe (Q12: "never a crash").
 */
function killZero(pid: number): KillZeroErrno {
  try {
    process.kill(pid, 0);
    return 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM' ? 'EPERM' : 'ESRCH';
  }
}

async function readFileIfReadable(path: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path, 'utf-8');
    return content.trim();
  } catch {
    return undefined;
  }
}

/** `/proc/<pid>/task/*\/children` -- one whitespace-separated line per task. */
async function readChildPids(pid: number): Promise<string[]> {
  try {
    const tasks = await fs.readdir(`/proc/${pid}/task`);
    const collected: string[] = [];
    for (const task of tasks) {
      const content = await readFileIfReadable(`/proc/${pid}/task/${task}/children`);
      if (content) collected.push(content);
    }
    return collected.join(' ').split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Positive control (workflow.md sub-pattern 9)
// ---------------------------------------------------------------------------

interface ControlResult {
  ok: boolean;
  detail: string;
}

/**
 * Spawns a process guaranteed to be alive at measurement time
 * (`sh -c 'sleep 100'`), confirms the SAME observable code path reports it
 * alive, kills it, and confirms the same code path reports it gone. A run
 * whose control fails exits 2 and prints no verdict: the instrument cannot
 * see, so it cannot report an absence.
 */
async function runPositiveControl(provider: PtyProvider): Promise<ControlResult> {
  const pty = provider.spawn('sh', ['-c', 'sleep 100'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });
  const pid = pty.pid;
  pty.onData(() => {});
  pty.onExit(() => {});

  await sleep(POSITIVE_CONTROL_SETTLE_MS);

  const procState = await readProcState(pid);
  const killZeroErrno = killZero(pid);

  if (procState !== 'S' || killZeroErrno !== 0) {
    pty.dispose?.();
    return {
      ok: false,
      detail: `control pid ${pid}: expected state=S/kill-0=0 for a freshly-spawned sleeper, got state=${String(procState)}/kill-0=${String(killZeroErrno)}`,
    };
  }

  try {
    pty.kill('SIGHUP');
  } catch (err) {
    pty.dispose?.();
    return { ok: false, detail: `control pid ${pid}: SIGHUP delivery threw: ${String(err)}` };
  }

  const settled = await waitForAsync(async () => {
    const state = await readProcState(pid);
    return state === undefined || state === 'Z';
  }, POSITIVE_CONTROL_KILL_WAIT_MS);

  pty.dispose?.();

  if (!settled) {
    return { ok: false, detail: `control pid ${pid}: neither exited nor zombified within ${POSITIVE_CONTROL_KILL_WAIT_MS}ms of SIGHUP` };
  }

  return {
    ok: true,
    detail: `control pid ${pid}: observed state=S/kill-0=0 while alive, gone-or-zombie within ${POSITIVE_CONTROL_KILL_WAIT_MS}ms after SIGHUP`,
  };
}

// ---------------------------------------------------------------------------
// Measurement cycle
// ---------------------------------------------------------------------------

interface TimeoutObservables {
  procState: string | undefined;
  killZeroErrno: KillZeroErrno;
  exitListenerFired: boolean;
  /**
   * Observable (3)'s second half: whether the Bun.spawn subprocess was
   * reachable through the provider's EXISTING public surface. `IPty` /
   * `PtyInstance` expose none (the AC forbids adding one to
   * pty-provider.ts), so this is always false -- stated explicitly rather
   * than omitted, per the AC's "otherwise by pty.pid + /proc only" clause.
   */
  subprocessReachableViaProviderSurface: false;
  bunVersion: string;
  loadavg: number[];
  contending: boolean;
  /** Whether the post-timeout grace window (Issue #1888) observed a late `onExit` fire. */
  exitFiredWithinGrace: boolean;
  /** Milliseconds from the timeout to the late `onExit` fire, or `undefined` if it never fired. */
  lateFireMs: number | undefined;
}

interface StuckChildDetail {
  wchan: string | undefined;
  stack: string | undefined;
  childPids: string[];
}

type CycleOutcome =
  | { outcome: 'exited'; cycle: number; pid: number; wallClockMs: number }
  | {
      outcome: 'timeout';
      cycle: number;
      pid: number;
      wallClockMs: number;
      observables: TimeoutObservables;
      verdict: Verdict;
      reason?: string;
      stuckDetail?: StuckChildDetail;
    };

/**
 * Spawns `sh -c 'echo ok'` via the real, selected `PtyProvider.spawn(...)`,
 * races its `onExit` against `timeoutMs` exactly as
 * `check-exit-127-diagnostic.ts`'s `selfCheck()` does (when `provider` is
 * `bunPtyProvider`), and on a lost race reads the four observables
 * synchronously, in the Architect-specified order, then opens a post-timeout
 * grace window (`graceMs`, Issue #1888) before cleanup to distinguish a
 * merely DELAYED exit from one that is genuinely LOST.
 */
async function runCycle(
  cycleNumber: number,
  timeoutMs: number,
  graceMs: number,
  contending: boolean,
  provider: PtyProvider,
): Promise<CycleOutcome> {
  const pty = provider.spawn('sh', ['-c', 'echo ok'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });
  const pid = pty.pid;
  const start = Date.now();

  let exitFired = false;
  let exitFiredAt: number | undefined;
  const exited = new Promise<void>((resolve) => {
    pty.onExit(() => {
      exitFired = true;
      exitFiredAt = Date.now();
      resolve();
    });
  });
  pty.onData(() => {});

  const ok = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)]);
  const timeoutAt = Date.now();
  const wallClockMs = timeoutAt - start;

  if (ok) {
    pty.dispose?.();
    return { outcome: 'exited', cycle: cycleNumber, pid, wallClockMs };
  }

  // Timeout path -- read in the exact order the AC specifies.
  const procState = await readProcState(pid); // (1)
  const killZeroErrno = killZero(pid); // (2)
  // (3) Snapshot NOW, not re-read later: killZero()'s own `process.kill(pid, 0)`
  // call above is a signal delivery, and this cycle's own cleanup below
  // (pty.kill('SIGKILL') / pty.dispose()) can synchronously invoke the
  // already-registered onExit listener as a side effect of the native
  // binding reaping the child -- observed directly during development (a
  // --timeout-ms 1 run printed verdict=LOST-EXIT alongside
  // exitListenerFired=true, which `classifyTimeout` can never produce; the
  // listener fired AFTER classification, between this read and the return
  // statement, because the live `exitFired` variable was re-read instead of
  // a frozen snapshot). Freezing here makes classification and the reported
  // observable use the IDENTICAL value, immune to anything this cycle's own
  // cleanup does afterward.
  const exitFiredAtTimeout = exitFired;
  const bunVersion = Bun.version; // (4)
  const loadavg = os.loadavg(); // (4)

  // Post-timeout grace window (Issue #1888): wait for a LATE `onExit` fire
  // BEFORE killing the child, so a delayed listener is not misread as lost.
  // `graceMs === 0` skips the wait entirely (reproduces the pre-#1888
  // behaviour: a late fire is never observed, so the verdict table below is
  // reached exactly as it was before this window existed). This read is
  // taken immediately after the race settles -- unlike the live re-read the
  // comment above warns against, nothing between here and this read can run
  // this cycle's own cleanup, so there is no risk of observing a fire caused
  // by `pty.kill`/`dispose` rather than the child's own exit.
  if (graceMs > 0) {
    await Promise.race([exited, sleep(graceMs)]);
  }
  const exitFiredWithinGrace = exitFired;
  const lateFireMs = exitFiredWithinGrace && exitFiredAt !== undefined ? exitFiredAt - timeoutAt : undefined;

  const { verdict, reason } = classifyTimeout({
    procState,
    killZeroErrno,
    exitFired: exitFiredAtTimeout,
    exitFiredWithinGrace,
  });

  let stuckDetail: StuckChildDetail | undefined;
  if (verdict === 'STUCK-CHILD') {
    stuckDetail = {
      wchan: await readFileIfReadable(`/proc/${pid}/wchan`),
      stack: await readFileIfReadable(`/proc/${pid}/stack`),
      childPids: await readChildPids(pid),
    };
  }

  // Cleanup: this IS a pid this run spawned. Kill it so it does not
  // accumulate across cycles; the observables above were already captured.
  try {
    pty.kill('SIGKILL');
  } catch {
    // best-effort
  }
  pty.dispose?.();

  return {
    outcome: 'timeout',
    cycle: cycleNumber,
    pid,
    wallClockMs,
    observables: {
      procState,
      killZeroErrno,
      exitListenerFired: exitFiredAtTimeout,
      subprocessReachableViaProviderSurface: false,
      bunVersion,
      loadavg,
      contending,
      exitFiredWithinGrace,
      lateFireMs,
    },
    verdict,
    reason,
    stuckDetail,
  };
}

// ---------------------------------------------------------------------------
// Contention generator
// ---------------------------------------------------------------------------

/**
 * Spawns `n` busy `bun -e` children (CPU spin + fork storm), owned by this
 * probe. Deliberately NOT `bun run test` -- that would collide with the
 * full-suite slot rule. Q13 proxy: stands in for "ordinary host
 * contention", upstream of and outside the chain under test.
 */
function spawnContendProcesses(n: number): Bun.Subprocess[] {
  const procs: Bun.Subprocess[] = [];
  for (let i = 0; i < n; i++) {
    const proc = Bun.spawn(['bun', '-e', 'while (true) { Bun.spawnSync(["true"]); }'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    procs.push(proc);
  }
  return procs;
}

function killContendProcesses(procs: Bun.Subprocess[]): void {
  for (const proc of procs) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // best-effort; this run owns these pids, cleanup must not throw
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  timeoutMs: number;
  cycles: number;
  contend: boolean;
  contendN: number;
  provider: PtyProviderName;
  graceMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let cycles = DEFAULT_CYCLES;
  let contend = false;
  let contendN = DEFAULT_CONTEND_N;
  let provider: PtyProviderName = DEFAULT_PROVIDER;
  let graceMs = DEFAULT_GRACE_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--timeout-ms': {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout-ms requires a positive number, got: ${String(raw)}`);
        timeoutMs = n;
        break;
      }
      case '--cycles': {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--cycles requires a positive integer, got: ${String(raw)}`);
        cycles = n;
        break;
      }
      case '--contend':
        contend = true;
        break;
      case '--contend-n': {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--contend-n requires a positive integer, got: ${String(raw)}`);
        contendN = n;
        break;
      }
      case '--provider': {
        const raw = argv[++i];
        if (raw !== 'bun-pty' && raw !== 'bun-terminal') {
          throw new Error(`--provider requires 'bun-pty' or 'bun-terminal', got: ${String(raw)}`);
        }
        provider = raw;
        break;
      }
      case '--grace-ms': {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`--grace-ms requires a non-negative number, got: ${String(raw)}`);
        graceMs = n;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { timeoutMs, cycles, contend, contendN, provider, graceMs };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Bad arguments: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  const provider = getPtyProvider(args.provider);

  console.log(
    `==> provider: ${args.provider}${args.provider === 'bun-terminal' ? ' (default -- production-configured BunTerminalPtyAdapter)' : ' (legacy opt-in, mirrors selfCheck() exactly)'}`,
  );
  console.log(`==> grace-ms: ${args.graceMs}${args.graceMs === 0 ? ' (grace window disabled -- pre-#1888 behaviour)' : ''}`);
  console.log('==> positive control: confirming the observable code path can see a live, then a dead, process');
  const control = await runPositiveControl(provider);
  if (!control.ok) {
    console.error(`CONTROL FAILED: ${control.detail}`);
    console.error('The instrument cannot see, so it cannot report an absence. No verdict printed.');
    process.exit(2);
    return;
  }
  console.log(`  OK  ${control.detail}`);

  const bunVersion = Bun.version;
  const loadavgStart = os.loadavg();
  console.log(
    `==> starting measurement loop: provider=${args.provider} cycles=${args.cycles} timeoutMs=${args.timeoutMs} graceMs=${args.graceMs} contend=${args.contend} contendN=${args.contendN} bunVersion=${bunVersion} loadavgStart=${loadavgStart.map((n) => n.toFixed(2)).join(',')}`,
  );

  let contendProcs: Bun.Subprocess[] = [];
  const outcomes: CycleOutcome[] = [];

  try {
    if (args.contend) {
      console.log(`==> spawning ${args.contendN} contention processes`);
      contendProcs = spawnContendProcesses(args.contendN);
    }

    for (let i = 1; i <= args.cycles; i++) {
      const outcome = await runCycle(i, args.timeoutMs, args.graceMs, args.contend, provider);
      outcomes.push(outcome);

      if (outcome.outcome === 'exited') {
        console.log(JSON.stringify({ cycle: outcome.cycle, pid: outcome.pid, outcome: 'exited', wallClockMs: outcome.wallClockMs }));
      } else {
        console.log(
          JSON.stringify({
            cycle: outcome.cycle,
            pid: outcome.pid,
            outcome: 'timeout',
            wallClockMs: outcome.wallClockMs,
            observables: outcome.observables,
            verdict: outcome.verdict,
            reason: outcome.reason,
            stuckDetail: outcome.stuckDetail,
          }),
        );
        console.log(
          `  VERDICT cycle=${outcome.cycle} pid=${outcome.pid} verdict=${outcome.verdict}` +
            (outcome.reason ? ` reason="${outcome.reason}"` : '') +
            ` procState=${String(outcome.observables.procState)} killZeroErrno=${String(outcome.observables.killZeroErrno)}` +
            ` exitListenerFired=${outcome.observables.exitListenerFired} exitFiredWithinGrace=${outcome.observables.exitFiredWithinGrace}` +
            ` lateFireMs=${String(outcome.observables.lateFireMs)} bunVersion=${outcome.observables.bunVersion}` +
            ` loadavg=${outcome.observables.loadavg.map((n) => n.toFixed(2)).join(',')} contending=${outcome.observables.contending}`,
        );
      }
    }
  } finally {
    if (contendProcs.length > 0) {
      console.log(`==> killing ${contendProcs.length} contention processes`);
      killContendProcesses(contendProcs);
    }
  }

  const loadavgEnd = os.loadavg();
  const failures = outcomes.filter((o): o is Extract<CycleOutcome, { outcome: 'timeout' }> => o.outcome === 'timeout');
  const verdictCounts: Record<Verdict, number> = { 'LOST-EXIT': 0, 'DELAYED-EXIT': 0, 'STUCK-CHILD': 0, INCONCLUSIVE: 0 };
  for (const failure of failures) verdictCounts[failure.verdict]++;

  console.log();
  console.log('==> summary');
  console.log(
    JSON.stringify({
      summary: true,
      provider: args.provider,
      cycles: args.cycles,
      graceMs: args.graceMs,
      contending: args.contend,
      failures: failures.length,
      verdictCounts,
      bunVersion,
      loadavgStart,
      loadavgEnd,
    }),
  );

  const exitCode = determineExitCode(
    outcomes.map((o) => (o.outcome === 'exited' ? { outcome: 'exited' as const } : { outcome: 'timeout' as const, verdict: o.verdict })),
  );
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`HARNESS FAILURE: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    console.error('No verdict printed.');
    process.exit(2);
  });
}
