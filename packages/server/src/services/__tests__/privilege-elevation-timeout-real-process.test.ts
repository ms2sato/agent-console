/**
 * Drives the REAL `runAsUser` timeout path against a REAL process tree (the
 * direct, non-elevated branch): a shell that backgrounds a long `sleep` and
 * waits for it. Before the tree-kill fix the timer killed only the shell, the
 * orphaned `sleep` kept the stdout pipe open, and `runAsUser` did not return
 * until the `sleep` exited. The observables are the call's elapsed time and
 * the background pid's liveness (ESRCH), not a string or a mock.
 *
 * Real-fs placement: it spawns real processes and sibling test files may
 * replace `privilege-elevation.js` process-globally with mocks, so this file
 * runs in the second (real-fs) `bun test` invocation (`package.json`) and
 * calls `assertRealFs` first. `runAsUser` itself is evaluated in a fresh
 * `bun` child (same technique as `privilege-elevation-cwd-real-shell.test.ts`)
 * so a mocked module in this process cannot stand in for the real one, and a
 * regression that hangs the call cannot hang this test: the child is bounded.
 *
 * Pid hygiene: the only pid this file ever signals is the background `sleep`
 * its own command created (recorded in a pid file inside a private temp dir),
 * and only after confirming by `ps` that it is still that `sleep`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVILEGE_ELEVATION_TS = join(SERVICES_DIR, 'privilege-elevation.ts');

/** Hard bound on the child so a regression fails instead of hanging 30 s. */
const CHILD_BOUND_MS = 8000;

let workDir: string;
let pidFile: string;

interface ChildReport {
  elapsedMs: number;
  result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

async function readBackgroundPid(): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True only while `pid` is still the `sleep 30` this test's command started. */
async function isOurSleep(pid: number): Promise<boolean> {
  const proc = Bun.spawn(['ps', '-o', 'args=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim() === 'sleep 30';
}

/** Runs the real `runAsUser` in a fresh bun child; returns its JSON report. */
async function runInChild(timeoutMs: number): Promise<ChildReport> {
  const command = `sleep 30 & echo $! > ${pidFile}; echo $!; wait`;
  const script = [
    `import { runAsUser } from ${JSON.stringify(PRIVILEGE_ELEVATION_TS)};`,
    'const started = Date.now();',
    'const result = await runAsUser({ username: null, command: process.argv[1], timeoutMs: Number(process.argv[2]) });',
    'console.log(JSON.stringify({ elapsedMs: Date.now() - started, result }));',
  ].join('\n');
  const proc = Bun.spawn(['bun', '-e', script, command, String(timeoutMs)], {
    cwd: workDir,
    env: { ...process.env, AUTH_MODE: 'none' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CHILD_BOUND_MS,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`child did not complete (exit ${code}, bound ${CHILD_BOUND_MS} ms): ${err}`);
  return JSON.parse(out.trim().split('\n').pop()!) as ChildReport;
}

describe('runAsUser timeout in a real process tree', () => {
  beforeAll(async () => {
    await assertRealFs('privilege-elevation-timeout-real-process');
    workDir = await mkdtemp(join(tmpdir(), 'runasuser-timeout-'));
    pidFile = join(workDir, 'bg.pid');
  });

  afterEach(async () => {
    // Safety net for a regression: only ever the sleep this test created.
    const pid = await readBackgroundPid();
    if (pid !== undefined && (await isOurSleep(pid))) {
      process.kill(pid, 'SIGKILL');
    }
    await rm(pidFile, { force: true });
  });

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true });
  });

  it('returns promptly with the partial output and leaves no background process behind', async () => {
    const report = await runInChild(200);

    expect(report.result.timedOut).toBe(true);
    expect(report.result.exitCode).toBe(137);
    expect(report.elapsedMs).toBeLessThan(3000);

    const pid = await readBackgroundPid();
    expect(pid).toBeDefined();
    expect(report.result.stdout).toContain(String(pid));

    // The background sleep is gone (ESRCH), not merely signalled.
    expect(await waitUntilGone(pid!, 2000)).toBe(true);
  }, 15_000);

  it('control: a command that finishes before the timeout is untouched by the tree walk', async () => {
    const script = [
      `import { runAsUser } from ${JSON.stringify(PRIVILEGE_ELEVATION_TS)};`,
      'const result = await runAsUser({ username: null, command: "echo fine", timeoutMs: 5000 });',
      'console.log(JSON.stringify(result));',
    ].join('\n');
    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: workDir,
      env: { ...process.env, AUTH_MODE: 'none' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CHILD_BOUND_MS,
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out.trim().split('\n').pop()!) as ChildReport['result'];
    expect(result).toMatchObject({ stdout: 'fine\n', exitCode: 0, timedOut: false });
  }, 15_000);
});
