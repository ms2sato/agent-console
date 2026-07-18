#!/usr/bin/env bun
/**
 * Post-deploy smoke test for `killAsUser` (Issue #1197 Part A).
 *
 * Drives the REAL production `spawnAsUser` / `killAsUser` helpers
 * (`packages/server/src/services/privilege-elevation.ts`) against a REAL
 * long-lived process, with `AUTH_MODE=multi-user` forced on so the elevated
 * `sudo -u <target-user> ... kill -s <SIG> -- <pid>` argv actually runs.
 *
 * What this smoke exercises:
 *   - `spawnAsUser` launching a real `sleep` as `<target-user>`, printing
 *     its own PID first (`echo $$; exec sleep 300`) so the smoke gets the
 *     PID of the actual long-lived process rather than the outer
 *     `sudo`/`sh` wrapper PID that `subprocess.pid` would report.
 *   - `killAsUser` sending a real elevated `SIGTERM` to that PID and the
 *     process actually terminating.
 *   - Negative assertion: a SECOND, unrelated `sleep` process survives the
 *     `killAsUser` call against the first one -- proving the helper signals
 *     exactly the targeted PID (`kill -s <SIG> -- <pid>`), not something
 *     broader like a name-based `pkill`.
 *   - Every subprocess-facing phase is bounded so a stalled sudo/NSS/
 *     login-shell chain on the target host surfaces as a clear timeout
 *     rather than hanging the deploy: the tracked-PID stdout read has a
 *     deadline (with reader cancellation on expiry), and both `killAsUser`
 *     calls pass an explicit `timeoutMs` (the underlying `runAsUser` sets NO
 *     timer at all when this is omitted). Any phase timing out exits with
 *     code 2 (environment problem), distinct from an assertion failure.
 *   - Cleanup verification: `killAsUser` resolves normally on a non-zero
 *     exit code or a timeout (it does not reject), so the best-effort
 *     cleanup pass inspects the result's `timedOut`/`exitCode` explicitly
 *     and re-checks actual PID survival afterward -- a process left behind
 *     by cleanup is recorded as a failure, not silently swallowed.
 *
 * What this smoke does NOT exercise:
 *   - `killAsUser`'s SIGTERM -> SIGKILL fallback orchestration -- that
 *     belongs to the CALLER (`SessionInitializationService.killOrphanWorkers`),
 *     not to `killAsUser` itself, which is a strict thin wrapper with no
 *     retry/fallback semantics of its own (see
 *     `.claude/rules/elevation-helpers.md`). Unit tests in
 *     `packages/server/src/services/__tests__/session-initialization-service.test.ts`
 *     cover that orchestration with an injected fake.
 *   - `isProcessAlive`'s ESRCH/EPERM distinction -- covered by
 *     `packages/server/src/lib/__tests__/process-utils.test.ts` (spies on
 *     `process.kill` directly; does not need a real second OS user).
 *
 * Usage:
 *   bun scripts/smoke/check-kill-as-user.ts <target-user>
 *
 * Requirements:
 *   - Run as a user with elevation privilege for <target-user> (a working,
 *     non-interactive `sudo -u <target-user> -i ...` path). On the dogfood
 *     host this typically means running as the agentconsole service user
 *     (sudoers rules from scripts/setup-multiuser-for-ubuntu.sh).
 *   - <target-user> must be a real OS user with a login shell.
 *   - Degenerate mode: passing the CURRENT process user as <target-user>
 *     exercises the entire mechanism (spawn, PID capture, kill, negative
 *     assertion) EXCEPT the actual cross-user `sudo` boundary, since
 *     `spawnAsUser` / `killAsUser` bypass elevation whenever the target user
 *     equals the server-process user (`shouldElevateForUser` returns
 *     false). Neither helper requires `AUTH_MODE=multi-user` to run in this
 *     mode -- degenerate mode works regardless of AUTH_MODE, because the
 *     bypass condition is evaluated independently of it. Useful when no
 *     second OS user + configured elevation is available.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (missing target user, spawn launch failure,
 *      or any phase (PID read, an elevated kill call) exceeding its bounded
 *      deadline -- treated as an environment problem, not a system-under-
 *      test assertion failure)
 *
 * Sync contract: `spawnAsUser` and `killAsUser` are imported directly from
 * `packages/server/src/services/privilege-elevation.ts` -- the exact
 * helpers production code uses. No replication.
 */

// Ad-hoc invocation inherits cwd from the caller (often /root or an
// interactive user's home, neither readable by an elevation-target service
// account). Bun's spawn machinery evaluates the calling process's cwd, and
// an inherited unreadable cwd produces EACCES on posix_spawn (same root
// cause documented in check-multiuser-pty-env.ts). Neutralize at script
// start.
process.chdir('/');

const targetUsername = process.argv[2];
if (!targetUsername) {
  console.error('usage: bun scripts/smoke/check-kill-as-user.ts <target-user>');
  process.exit(2);
}

// Unlike embedded-agent-worker-service.js / app-context.js, privilege-elevation.ts
// reads `process.env.AUTH_MODE` at CALL time inside `runAsUser` / `spawnAsUser`
// (not via a module-load-time IIFE), so a plain static import + setting this
// env var beforehand is sufficient -- no deferred dynamic-import ordering
// dance is required here.
process.env.AUTH_MODE = 'multi-user';

import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { spawnAsUser, killAsUser } from '../../packages/server/src/services/privilege-elevation.js';

/**
 * `killAsUser` sets no timer at all when `timeoutMs` is omitted (`runAsUser`
 * only starts a timeout `setTimeout` when the caller passes one). Without an
 * explicit bound, a stalled sudo/NSS/login-shell chain on the target host
 * would hang this smoke's `await` indefinitely instead of surfacing as a
 * clear probe failure.
 */
const KILL_AS_USER_TIMEOUT_MS = 10_000;

/** Deadline for reading the tracked PID's first stdout line. */
const PID_READ_TIMEOUT_MS = 15_000;

/**
 * Distinguishes "a phase of this probe hung past its deadline" from a normal
 * assertion failure. Caught at the top level and mapped to exit code 2
 * (probe-cannot-run / environment problem), not exit code 1 (assertion
 * failed) -- per this script's own documented exit-code convention.
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
// user owns the target process -- unlike `kill -0 <pid>` as the smoke's own
// (possibly non-elevated) user, which would itself hit the EPERM case this
// whole feature exists to route around, and unlike reading
// /proc/<pid>/status's contents (which can be permission-gated). Existence
// of the /proc/<pid> directory entry itself is not.
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
 * Spawn `sleep <seconds>` as `username`, printing its own PID on the first
 * stdout line before exec'ing into sleep (`echo $$; exec sleep <seconds>`).
 * This is more robust than `pgrep`-ing for a live sleep afterwards (no race,
 * no ambiguity if multiple sleeps happen to be running for the same user)
 * and more accurate than `subprocess.pid` (which is the outer
 * `sudo`/`sh` wrapper PID when elevated, not the actual `sleep` PID).
 */
async function spawnTrackedSleep(username: string, seconds: number): Promise<number> {
  const { subprocess, stdin } = spawnAsUser({
    username,
    command: `echo $$; exec sleep ${seconds}`,
  });
  // Fire-and-forget spawn: nothing is fed to stdin. Mandatory per
  // `.claude/rules/elevation-helpers.md` "spawnAsUser: close stdin when not
  // feeding input" -- without this the child could block indefinitely
  // waiting on stdin.
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
    // Release the stalled read so the underlying subprocess pipe doesn't
    // keep this probe's event loop alive after we've already given up.
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
    throw new Error(`PROBE FAILED: could not parse tracked sleep PID from output: ${JSON.stringify(buffered)}`);
  }
  return pid;
}

async function main(): Promise<void> {
  const serverUsername = os.userInfo().username;
  const degenerate = targetUsername === serverUsername;
  if (degenerate) {
    console.warn(
      `  WARN  target user '${targetUsername}' equals the server-process user; spawnAsUser/killAsUser` +
        ' will bypass elevation (degenerate same-user mode). This still exercises the full' +
        ' mechanism except the actual sudo OS-user-boundary crossing.',
    );
  }

  let targetPid: number | undefined;
  let controlPid: number | undefined;
  let timedOut = false;

  try {
    console.log(`==> spawning tracked target sleep as '${targetUsername}' (elevated: ${!degenerate})`);
    targetPid = await spawnTrackedSleep(targetUsername, 300);
    console.log(`  target sleep pid: ${targetPid}`);

    console.log(`==> spawning tracked CONTROL sleep as '${targetUsername}' (negative-assertion witness)`);
    controlPid = await spawnTrackedSleep(targetUsername, 300);
    console.log(`  control sleep pid: ${controlPid}`);

    console.log('==> sanity: both pids alive before killAsUser');
    expect(procAlive(targetPid), 'target pid is alive before killAsUser', `pid=${targetPid}`);
    expect(procAlive(controlPid), 'control pid is alive before killAsUser', `pid=${controlPid}`);

    console.log(`==> killAsUser(${targetPid}, 'SIGTERM', '${targetUsername}')`);
    const result = await killAsUser(targetPid, 'SIGTERM', targetUsername, { timeoutMs: KILL_AS_USER_TIMEOUT_MS });
    if (result.timedOut) {
      throw new ProbeTimeoutError(`killAsUser SIGTERM timed out after ${KILL_AS_USER_TIMEOUT_MS}ms`);
    }
    expect(result.exitCode === 0, 'killAsUser SIGTERM exitCode === 0', `got exitCode=${result.exitCode} stderr=${result.stderr}`);

    console.log('==> waiting for target pid to exit (bounded poll, up to 5s)');
    const targetGone = await waitUntilGone(targetPid, 5_000);
    expect(targetGone, 'target pid is gone after killAsUser SIGTERM', `pid=${targetPid} still present in /proc`);

    console.log('==> negative assertion: control pid must still be alive (killAsUser targeted only the intended pid)');
    expect(procAlive(controlPid), 'control pid is still alive after killAsUser on the target pid', `pid=${controlPid}`);
  } catch (err) {
    if (err instanceof ProbeTimeoutError) {
      timedOut = true;
      console.error('PROBE TIMEOUT:', err.message);
    } else {
      console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      failures.push('unexpected exception during smoke run');
    }
  } finally {
    console.log('==> cleanup (best-effort SIGKILL of any surviving tracked pids, verified)');
    for (const pid of [targetPid, controlPid]) {
      if (pid === undefined) continue;
      if (!procAlive(pid)) continue;
      // `killAsUser` resolves normally even on a non-zero exit code or a
      // timeout (see privilege-elevation.ts docs) -- it does NOT reject the
      // promise in either case. A bare try/catch around the call therefore
      // cannot detect most cleanup failures; the result's `timedOut` /
      // `exitCode` must be inspected explicitly, and actual PID survival
      // must be re-checked afterward rather than assumed from a clean call.
      try {
        const cleanupResult = await killAsUser(pid, 'SIGKILL', targetUsername, { timeoutMs: KILL_AS_USER_TIMEOUT_MS });
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
      // Silent success is not acceptable here: a tracked process surviving
      // best-effort cleanup is itself a real finding (dogfood no-leftover
      // discipline), not something to swallow.
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
