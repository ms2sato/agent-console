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
 *   2  bad usage / cannot run (missing target user, spawn launch failure)
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
  while (!buffered.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();

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
    const result = await killAsUser(targetPid, 'SIGTERM', targetUsername);
    expect(result.exitCode === 0, 'killAsUser SIGTERM exitCode === 0', `got exitCode=${result.exitCode} stderr=${result.stderr}`);

    console.log('==> waiting for target pid to exit (bounded poll, up to 5s)');
    const targetGone = await waitUntilGone(targetPid, 5_000);
    expect(targetGone, 'target pid is gone after killAsUser SIGTERM', `pid=${targetPid} still present in /proc`);

    console.log('==> negative assertion: control pid must still be alive (killAsUser targeted only the intended pid)');
    expect(procAlive(controlPid), 'control pid is still alive after killAsUser on the target pid', `pid=${controlPid}`);
  } catch (err) {
    console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    failures.push('unexpected exception during smoke run');
  } finally {
    console.log('==> cleanup (best-effort SIGKILL of any surviving tracked pids)');
    for (const pid of [targetPid, controlPid]) {
      if (pid === undefined) continue;
      if (!procAlive(pid)) continue;
      try {
        await killAsUser(pid, 'SIGKILL', targetUsername);
      } catch (err) {
        console.warn(`  cleanup: killAsUser SIGKILL failed for pid=${pid} (best-effort):`, err);
      }
    }
  }

  console.log();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('PROBE FAILED (uncaught):', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(2);
});
