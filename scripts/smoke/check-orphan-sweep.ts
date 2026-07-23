#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the SESSION_ID marker orphan-process sweep
 * (Issue #1197 Part B).
 *
 * Drives the REAL production `spawnAsUser` / `sweepOrphanProcesses` helpers
 * (`packages/server/src/services/privilege-elevation.ts` /
 * `packages/server/src/services/orphan-process-sweeper.ts`) against REAL
 * long-lived processes, with `AUTH_MODE=multi-user` forced on so the
 * elevated `sudo -u <target-user> ... sh -c <sweep script>` argv actually
 * runs.
 *
 * What this smoke exercises:
 *   - `spawnAsUser` launching a real `sleep` as `<target-user>` with
 *     `AGENT_CONSOLE_SESSION_ID=<generated-session-id>` set in its
 *     environment -- the same env marker every real worker process carries
 *     in production (`user-mode.ts`).
 *   - `sweepOrphanProcesses` running the marker-scan-and-kill script AS
 *     `<target-user>` (a real cross-user `/proc/<pid>/environ` read, which
 *     the server process itself cannot do directly -- that permission
 *     boundary is the entire reason the scan has to run elevated) and
 *     actually terminating the marked process.
 *   - Negative assertion: a second, real process spawned as the same
 *     target user WITHOUT the marker survives the sweep -- proof the sweep
 *     matches on the exact SESSION_ID record, not a broader name-based or
 *     substring match.
 *   - Every subprocess-facing phase is bounded so a stalled sudo/NSS/
 *     login-shell chain, or a stuck sweep script, surfaces as a clear
 *     timeout rather than hanging the deploy.
 *   - Cleanup verification: leftover tracked pids are force-killed via
 *     `killAsUser` in a `finally` block and re-checked, not assumed gone.
 *
 * What this smoke does NOT exercise:
 *   - The TERM -> KILL escalation path for a marked process that ignores
 *     SIGTERM (`trap '' TERM`). That is covered by the real-process Tier B
 *     tests in
 *     `packages/server/src/services/__tests__/orphan-process-sweeper.test.ts`,
 *     which drive `buildSweepScript`'s output directly via `Bun.spawn`
 *     (same-user, no elevation needed to exercise the shell script's own
 *     grace/escalation logic).
 *   - `SessionInitializationService.sweepSessionProcesses`'s best-effort
 *     wrapping (non-throw on failure, logging) -- covered by unit tests
 *     with an injected fake in
 *     `packages/server/src/services/__tests__/session-initialization-service.test.ts`.
 *   - What Part A's smoke (`check-kill-as-user.ts`) already proves: that a
 *     single tracked pid can be elevated-signalled at all. This smoke's
 *     distinct value is proving the marker-based DISCOVERY mechanism
 *     itself works end-to-end against real `sudo` / real `/proc` read
 *     permissions -- Part A never reads `environ`, it only signals an
 *     already-known pid.
 *
 * Usage:
 *   bun scripts/smoke/check-orphan-sweep.ts <target-user>
 *
 * Requirements:
 *   - Run as a user with elevation privilege for <target-user> (a working,
 *     non-interactive `sudo -u <target-user> -i ...` path). On the dogfood
 *     host this typically means running as the agentconsole service user
 *     (sudoers rules from scripts/setup-multiuser-for-ubuntu.sh).
 *   - <target-user> must be a real OS user with a login shell.
 *   - Degenerate mode: passing the CURRENT process user as <target-user>
 *     exercises the entire mechanism (spawn, marker match, kill, negative
 *     assertion) EXCEPT the actual cross-user `sudo` boundary and the
 *     cross-user `/proc/<pid>/environ` read permission, since
 *     `spawnAsUser` / `sweepOrphanProcesses` (via `runAsUser`) bypass
 *     elevation whenever the target user equals the server-process user.
 *     Useful when no second OS user + configured elevation is available.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (missing target user, spawn launch failure,
 *      or any phase (PID read, the sweep call) exceeding its bounded
 *      deadline -- treated as an environment problem, not a system-under-
 *      test assertion failure)
 *
 * Sync contract: `spawnAsUser`, `killAsUser`, and `sweepOrphanProcesses`
 * are imported directly from their production modules -- no replication.
 */

// Ad-hoc invocation inherits cwd from the caller (often /root or an
// interactive user's home, neither readable by an elevation-target service
// account). Neutralize at script start -- same root cause documented in
// check-multiuser-pty-env.ts / check-kill-as-user.ts.
process.chdir('/');

const targetUsername = process.argv[2];
if (!targetUsername) {
  console.error('usage: bun scripts/smoke/check-orphan-sweep.ts <target-user>');
  process.exit(2);
}

// privilege-elevation.ts reads `process.env.AUTH_MODE` at CALL time inside
// `runAsUser` / `spawnAsUser` (not via a module-load-time IIFE), so a plain
// static import + setting this env var beforehand is sufficient.
process.env.AUTH_MODE = 'multi-user';

import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnAsUser, killAsUser } from '../../packages/server/src/services/privilege-elevation.js';
import { sweepOrphanProcesses } from '../../packages/server/src/services/orphan-process-sweeper.js';

/** Deadline for reading a tracked process's first stdout line (its own PID). */
const PID_READ_TIMEOUT_MS = 15_000;

/**
 * `sweepOrphanProcesses` forwards `timeoutMs` straight to `runAsUser`,
 * which sets no timer at all when it is omitted. The sweep script itself
 * waits out a grace period (default 2s) plus a bounded escalation poll (up
 * to ~1s) on top of the scan -- so this needs materially more headroom
 * than a single `kill -s <SIG> -- <pid>` call. Mirrors
 * `SWEEP_ORPHAN_PROCESSES_TIMEOUT_MS` in `session-initialization-service.ts`.
 */
const SWEEP_TIMEOUT_MS = 20_000;

/** Deadline for the cleanup-pass `killAsUser` fallback. */
const CLEANUP_KILL_TIMEOUT_MS = 10_000;

/**
 * Distinguishes "a phase of this probe hung past its deadline" from a
 * normal assertion failure. Caught at the top level and mapped to exit
 * code 2 (probe-cannot-run / environment problem), not exit code 1
 * (assertion failed).
 */
class ProbeTimeoutError extends Error {}

const failures: string[] = [];
let passes = 0;
const expect = (cond: boolean, label: string, detail?: string): void => {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
};

// Directory-existence check on /proc/<pid> works regardless of which OS
// user owns the target process -- see check-kill-as-user.ts's identical
// rationale for why this is preferred over `kill -0 <pid>` as the smoke's
// own (possibly non-elevated) user.
function procAlive(pid: number): boolean {
  return existsSync(`/proc/${pid}`);
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!procAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !procAlive(pid);
}

/**
 * Spawn `sleep <seconds>` as `username`, optionally carrying
 * `AGENT_CONSOLE_SESSION_ID=<sessionId>` in its environment, printing its
 * own PID on the first stdout line before `exec`'ing into sleep (mirrors
 * `check-kill-as-user.ts`'s `spawnTrackedSleep`: `exec` replaces the shell
 * process image in place, so the printed PID is the actual long-lived
 * process's PID, not an outer sudo/sh wrapper's).
 */
async function spawnTrackedMarked(
  username: string,
  sessionId: string | undefined,
  seconds: number,
): Promise<number> {
  const { subprocess, stdin } = spawnAsUser({
    username,
    command: `echo $$; exec sleep ${seconds}`,
    env: sessionId !== undefined ? { AGENT_CONSOLE_SESSION_ID: sessionId } : undefined,
  });
  // Fire-and-forget spawn: nothing is fed to stdin. Mandatory per
  // `.claude/rules/elevation-helpers.md` "spawnAsUser: close stdin when
  // not feeding input".
  stdin.end();

  const reader = subprocess.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const deadline = Date.now() + PID_READ_TIMEOUT_MS;
  try {
    while (!buffered.includes('\n')) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ProbeTimeoutError(
          `reading tracked PID line timed out after ${PID_READ_TIMEOUT_MS}ms (stalled sudo/NSS/login-shell path?)`,
        );
      }
      let timer: ReturnType<typeof setTimeout>;
      const readOrTimeout = Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ProbeTimeoutError(`reader.read() timed out after ${remainingMs}ms`)),
            remainingMs,
          );
        }),
      ]);
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await readOrTimeout;
      } finally {
        clearTimeout(timer!);
      }
      const { value, done } = readResult;
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    await reader.cancel('PID read deadline exceeded').catch(() => {});
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best-effort: cancel() above may have already settled the lock.
    }
  }

  const firstLine = buffered.split('\n')[0]?.trim();
  const pid = firstLine ? Number(firstLine) : NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`PROBE FAILED: could not parse tracked PID from output: ${JSON.stringify(buffered)}`);
  }
  return pid;
}

async function main(): Promise<void> {
  const serverUsername = os.userInfo().username;
  const degenerate = targetUsername === serverUsername;
  if (degenerate) {
    console.warn(
      `  WARN  target user '${targetUsername}' equals the server-process user; sweepOrphanProcesses` +
        ' will bypass elevation for both the scan and the spawn (degenerate same-user mode). This' +
        ' still exercises the full mechanism except the actual sudo OS-user-boundary crossing and' +
        ' the cross-user /proc/<pid>/environ read permission.',
    );
  }

  const sessionId = `smoke-orphan-sweep-${randomUUID()}`;
  let markedPid: number | undefined;
  let controlPid: number | undefined;
  let timedOut = false;

  try {
    console.log(`==> spawning MARKED tracked sleep as '${targetUsername}' (sessionId=${sessionId})`);
    markedPid = await spawnTrackedMarked(targetUsername, sessionId, 300);
    console.log(`  marked sleep pid: ${markedPid}`);

    console.log(`==> spawning UNMARKED control sleep as '${targetUsername}' (no AGENT_CONSOLE_SESSION_ID)`);
    controlPid = await spawnTrackedMarked(targetUsername, undefined, 300);
    console.log(`  control sleep pid: ${controlPid}`);

    console.log('==> sanity: both pids alive before sweepOrphanProcesses');
    expect(procAlive(markedPid), 'marked pid is alive before sweep', `pid=${markedPid}`);
    expect(procAlive(controlPid), 'control pid is alive before sweep', `pid=${controlPid}`);

    console.log(`==> sweepOrphanProcesses('${sessionId}', '${targetUsername}')`);
    const result = await sweepOrphanProcesses(sessionId, targetUsername, { timeoutMs: SWEEP_TIMEOUT_MS });
    if (result.raw.timedOut) {
      throw new ProbeTimeoutError(`sweepOrphanProcesses timed out after ${SWEEP_TIMEOUT_MS}ms`);
    }
    expect(
      result.raw.exitCode === 0,
      'sweepOrphanProcesses script exitCode === 0',
      `got exitCode=${result.raw.exitCode} stderr=${result.raw.stderr}`,
    );
    expect(result.killedCount === 1, 'sweepOrphanProcesses reports exactly 1 killed', `got killedCount=${result.killedCount}`);

    console.log('==> waiting for marked pid to exit (bounded poll, up to 8s)');
    const markedGone = await waitUntilGone(markedPid, 8_000);
    expect(markedGone, 'marked pid is gone after sweepOrphanProcesses', `pid=${markedPid} still present in /proc`);

    console.log('==> negative assertion: control pid must still be alive (sweep matched only the marked SESSION_ID)');
    expect(procAlive(controlPid), 'control pid is still alive after sweeping the marked session', `pid=${controlPid}`);
  } catch (err) {
    if (err instanceof ProbeTimeoutError) {
      timedOut = true;
      console.error('PROBE TIMEOUT:', err.message);
    } else {
      console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      failures.push('unexpected exception during smoke run');
    }
  } finally {
    console.log('==> cleanup (best-effort elevated SIGKILL of any surviving tracked pids, verified)');
    for (const pid of [markedPid, controlPid]) {
      if (pid === undefined) continue;
      if (!procAlive(pid)) continue;
      // `killAsUser` resolves normally even on a non-zero exit code or a
      // timeout -- it does NOT reject the promise in either case. Inspect
      // the result explicitly and re-check actual PID survival afterward
      // rather than assuming a clean call means the process is gone.
      try {
        const cleanupResult = await killAsUser(pid, 'SIGKILL', targetUsername, { timeoutMs: CLEANUP_KILL_TIMEOUT_MS });
        if (cleanupResult.timedOut || cleanupResult.exitCode !== 0) {
          console.warn(
            `  cleanup: killAsUser SIGKILL non-success for pid=${pid}` +
              ` (timedOut=${cleanupResult.timedOut}, exitCode=${cleanupResult.exitCode}, stderr=${cleanupResult.stderr})`,
          );
        }
      } catch (err) {
        console.warn(`  cleanup: killAsUser SIGKILL threw for pid=${pid} (best-effort):`, err);
      }
      const goneAfterCleanup = await waitUntilGone(pid, 3_000);
      expect(goneAfterCleanup, `cleanup left no surviving process for pid=${pid}`, `pid=${pid} still present in /proc after SIGKILL + wait`);
    }
  }

  console.log();
  if (timedOut) {
    console.error('PROBE TIMED OUT: a phase of this smoke exceeded its deadline (environment problem, not an assertion failure)');
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof ProbeTimeoutError) {
    console.error('PROBE TIMEOUT (uncaught):', err.message);
    process.exit(2);
  }
  console.error('PROBE FAILED (uncaught):', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(2);
});
