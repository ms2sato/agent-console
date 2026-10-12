#!/usr/bin/env bun
/**
 * Tier-2 smoke for the elevated process-group kill of `run_process` children.
 *
 * Drives the REAL production `InteractiveProcessManager.runProcess` /
 * `killProcess` (with the real `spawnAsUser`, `discoverElevatedPgid` and
 * `killProcessGroupAsUser`) against a REAL second OS user, with
 * `AUTH_MODE=multi-user` forced on so the elevated login-shell path actually
 * runs. The child is `sh -c 'sleep 300 & wait'`-shaped: a shell that
 * backgrounds a grandchild. Signalling only the shell (the pre-fix shape)
 * leaves the grandchild running.
 *
 * What this smoke asserts (default mode):
 *   - The grandchild `sleep` leads no group of its own but shares the group
 *     of the shell (pgid === shell pid): the group leader was created inside
 *     the elevated login shell as the target user.
 *   - After `killProcess`, the grandchild is gone within 2 s.
 *   - Negative control: an unrelated `sleep` of the same user, outside the
 *     group, is still alive afterwards (the group signal is not a
 *     name-based or user-wide kill).
 *
 * `--expect-leak` is the polarity mode. It builds the manager with a spawn
 * seam that strips `newProcessGroup` (the pre-fix shape) and asserts the
 * grandchild SURVIVES `killProcess` -- i.e. that this apparatus reaches the
 * defect. A run that does not leak is a polarity failure, never tolerated.
 *
 * Liveness is read from `/proc/<pid>/stat` and a zombie counts as gone: in a
 * container without an init reaper an exited grandchild stays `<defunct>`
 * forever, and a bare `/proc/<pid>` existence check would call it alive.
 *
 * Usage:
 *   bun scripts/smoke/check-run-process-elevated-group-kill.ts <target-user> [--expect-leak]
 *
 * Requirements: elevation privilege for <target-user> (a real OS user with a
 * login shell). Passing the CURRENT process user runs the degenerate direct
 * branch (a detached group signalled with a negative pid): everything except
 * the cross-user boundary.
 *
 * Exit codes: 0 all assertions passed; 1 an assertion failed; 2 bad usage or
 * a phase exceeded its bounded deadline (environment problem).
 */

import './_env.js';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import {
  spawnAsUser,
  killAsUser,
  runAsUser,
  type SpawnAsUserFn,
} from '../../packages/server/src/services/privilege-elevation.js';
import { InteractiveProcessManager } from '../../packages/server/src/services/interactive-process-manager.js';

const KILL_AS_USER_TIMEOUT_MS = 10_000;
const PHASE_TIMEOUT_MS = 20_000;
/** The AC's bound: the grandchild must be gone this soon after killProcess. */
const GROUP_KILL_DEADLINE_MS = 2_000;

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

/** Alive = /proc/<pid>/stat exists and its state is not Z (zombie) or X (dead). */
export function procLive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return false;
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0);
  return state !== 'Z' && state !== 'X';
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!procLive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !procLive(pid);
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new ProbeTimeoutError(`${what} did not happen within ${PHASE_TIMEOUT_MS}ms`);
}

/** Parse "<shellPid>\n<sleepPid>\n" from the child's output. */
export function parseTwoPids(output: string): { shellPid: number; sleepPid: number } | undefined {
  const nums = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
  return nums.length >= 2 ? { shellPid: nums[0], sleepPid: nums[1] } : undefined;
}

/** Spawn `exec sleep` outside any group of the manager; returns its pid. */
async function spawnControlSleep(username: string): Promise<number> {
  const { subprocess, stdin } = spawnAsUser({ username, command: 'echo $$; exec sleep 300' });
  stdin.end();
  const reader = subprocess.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  try {
    while (!buffered.includes('\n')) {
      if (Date.now() > deadline) throw new ProbeTimeoutError('control sleep pid line');
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const pid = Number(buffered.split('\n')[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`could not parse control sleep pid from ${JSON.stringify(buffered)}`);
  }
  return pid;
}

async function main(): Promise<void> {
  process.chdir('/');

  const args = process.argv.slice(2);
  const expectLeak = args.includes('--expect-leak');
  const targetUsername = args.find((a) => !a.startsWith('--'));
  if (!targetUsername) {
    console.error('usage: bun scripts/smoke/check-run-process-elevated-group-kill.ts <target-user> [--expect-leak]');
    process.exit(2);
  }

  process.env.AUTH_MODE = 'multi-user';
  const degenerate = targetUsername === os.userInfo().username;
  if (degenerate) {
    console.warn(
      `  WARN  target user '${targetUsername}' equals the server-process user; the direct (detached group)` +
        ' branch runs instead of the elevated one.',
    );
  }

  // Pre-fix shape for the polarity mode: never ask for a process group, so
  // the manager signals only the wrapper pid, exactly as before the fix.
  const spawnSeam: SpawnAsUserFn | undefined = expectLeak
    ? (opts) => spawnAsUser({ ...opts, newProcessGroup: false })
    : undefined;

  let output = '';
  const manager = new InteractiveProcessManager(
    (_proc, text) => {
      output += text;
    },
    () => {},
    undefined,
    undefined,
    spawnSeam,
  );

  let sleepPid: number | undefined;
  let controlPid: number | undefined;
  let timedOut = false;

  try {
    console.log(`==> control sleep as '${targetUsername}' (outside the group)`);
    controlPid = await spawnControlSleep(targetUsername);
    console.log(`  control sleep pid: ${controlPid}`);

    console.log(`==> run_process as '${targetUsername}': shell that backgrounds a grandchild (elevated: ${!degenerate}, expect-leak: ${expectLeak})`);
    const started = await manager.runProcess({
      sessionId: 'smoke-session',
      workerId: 'smoke-worker',
      command: 'echo $$; sleep 300 & echo $!; wait',
      requestUser: targetUsername,
      timeoutSeconds: 120,
    });
    const pids = await waitFor(() => parseTwoPids(output), 'shell and grandchild pid output');
    sleepPid = pids.sleepPid;
    console.log(`  shell pid: ${pids.shellPid}, grandchild sleep pid: ${sleepPid}`);
    expect(procLive(sleepPid), 'grandchild is alive before killProcess');
    expect(procLive(controlPid), 'control sleep is alive before killProcess');

    const pgidResult = await runAsUser({
      username: targetUsername,
      command: `ps -o pgid= -p ${sleepPid}`,
      cwd: '/',
      timeoutMs: KILL_AS_USER_TIMEOUT_MS,
    });
    const grandchildPgid = Number(pgidResult.stdout.trim());
    if (expectLeak) {
      expect(
        grandchildPgid !== pids.shellPid,
        'pre-fix shape: the shell does not lead a group of its own',
        `pgid=${grandchildPgid} shell=${pids.shellPid}`,
      );
    } else {
      expect(
        grandchildPgid === pids.shellPid,
        'the shell leads its own group and the grandchild is in it (pgid === shell pid)',
        `pgid=${grandchildPgid} shell=${pids.shellPid}`,
      );
    }

    console.log('==> killProcess');
    expect(manager.killProcess(started.id), 'killProcess returns true synchronously');
    const gone = await waitUntilGone(sleepPid, GROUP_KILL_DEADLINE_MS);
    if (expectLeak) {
      expect(!gone, 'POLARITY: the grandchild survives killProcess in the pre-fix shape (defect reproduced)');
    } else {
      expect(gone, `grandchild is gone within ${GROUP_KILL_DEADLINE_MS}ms of killProcess`, `pid=${sleepPid} still live`);
    }

    expect(procLive(controlPid), 'negative control: the sleep outside the group is still alive');
  } catch (err) {
    if (err instanceof ProbeTimeoutError) {
      timedOut = true;
      console.error('PROBE TIMEOUT:', err.message);
    } else {
      console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      failures.push('unexpected exception during smoke run');
    }
  } finally {
    console.log('==> cleanup (SIGKILL of any surviving tracked pids, verified)');
    manager.disposeAll();
    for (const pid of [sleepPid, controlPid]) {
      if (pid === undefined || !procLive(pid)) continue;
      const r = await killAsUser(pid, 'SIGKILL', targetUsername, { timeoutMs: KILL_AS_USER_TIMEOUT_MS });
      if (r.timedOut || r.exitCode !== 0) {
        console.warn(`  cleanup: killAsUser non-success for pid=${pid} (exit=${r.exitCode}, stderr=${r.stderr})`);
      }
      expect(await waitUntilGone(pid, 3_000), `cleanup left no surviving process for pid=${pid}`);
    }
  }

  console.log();
  if (timedOut) {
    console.error('PROBE TIMED OUT: a phase exceeded its deadline (environment problem, not an assertion failure)');
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('PROBE FAILED (uncaught):', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(2);
  });
}
