import { describe, it, expect, afterEach } from 'bun:test';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { shellEscape, type RunAsUserResult, type runAsUser } from '../privilege-elevation.js';
import {
  buildSweepScript,
  parseSweptCount,
  sweepOrphanProcesses,
} from '../orphan-process-sweeper.js';

function okResult(overrides: Partial<RunAsUserResult> = {}): RunAsUserResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...overrides };
}

// ============================================================
// Tier A — pure / fast (no real spawning, no elevation)
// ============================================================

describe('buildSweepScript', () => {
  it('embeds the session ID via shellEscape (single-quote-safe)', () => {
    const sessionId = "sess'id";
    const script = buildSweepScript(sessionId, { killGraceMs: 2000 });
    const expectedMarker = shellEscape(`AGENT_CONSOLE_SESSION_ID=${sessionId}`);
    expect(script).toContain(`marker=${expectedMarker}`);
  });

  it('does not embed a session ID containing a single quote unescaped (injection safety)', () => {
    const sessionId = "sess'; rm -rf /tmp/whatever; echo pwned '";
    const script = buildSweepScript(sessionId, { killGraceMs: 2000 });
    // The naive, unescaped form (bare single quote breaking out of the
    // quoted shell literal) must never appear -- shellEscape must have
    // converted each embedded quote into the '\'' escape sequence.
    expect(script).not.toContain(`marker='AGENT_CONSOLE_SESSION_ID=${sessionId}'`);
    // The properly-escaped form (produced by the same shellEscape helper
    // the production code calls) must be present.
    const expectedMarker = shellEscape(`AGENT_CONSOLE_SESSION_ID=${sessionId}`);
    expect(script).toContain(`marker=${expectedMarker}`);
  });

  it('issues SIGTERM before SIGKILL', () => {
    const script = buildSweepScript('sess-1', { killGraceMs: 2000 });
    const termIdx = script.indexOf('kill -s TERM');
    const killIdx = script.indexOf('kill -s KILL');
    expect(termIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(-1);
    expect(termIdx).toBeLessThan(killIdx);
  });

  it('references SWEEP_PROC_ROOT with a /proc fallback', () => {
    const script = buildSweepScript('sess-1', { killGraceMs: 2000 });
    expect(script).toContain('proc_root="${SWEEP_PROC_ROOT:-/proc}"');
  });

  it('excludes its own pid ($$) from candidates', () => {
    const script = buildSweepScript('sess-1', { killGraceMs: 2000 });
    expect(script).toContain('self_pid=$$');
    expect(script).toContain('[ "$pid" = "$self_pid" ] && continue');
  });

  it('embeds the requested grace period as fractional seconds for sleep', () => {
    const script = buildSweepScript('sess-1', { killGraceMs: 500 });
    expect(script).toContain('sleep 0.5');
  });
});

describe('parseSweptCount', () => {
  it('parses "SWEPT=0" as 0', () => {
    expect(parseSweptCount('SWEPT=0\n')).toBe(0);
  });

  it('parses "SWEPT=5" as 5', () => {
    expect(parseSweptCount('SWEPT=5\n')).toBe(5);
  });

  it('returns 0 for empty stdout', () => {
    expect(parseSweptCount('')).toBe(0);
  });

  it('returns 0 for garbage / no matching line', () => {
    expect(parseSweptCount('not well formed output\nnothing here\n')).toBe(0);
  });

  it('parses the correct line out of noise (embedded near-matches do not count)', () => {
    const stdout = 'some log line\nNOISE SWEPT=999 trailing noise\nSWEPT=3\nmore junk\n';
    expect(parseSweptCount(stdout)).toBe(3);
  });
});

describe('sweepOrphanProcesses (unit, injected runAsUserImpl fake)', () => {
  it('forwards username, cwd, and timeoutMs to runAsUserImpl', async () => {
    const calls: Array<Parameters<typeof runAsUser>[0]> = [];
    const fake: typeof runAsUser = async (opts) => {
      calls.push(opts);
      return okResult({ stdout: 'SWEPT=0\n' });
    };

    await sweepOrphanProcesses('sess-1', 'target-user', {
      runAsUserImpl: fake,
      timeoutMs: 12345,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.username).toBe('target-user');
    expect(calls[0]?.cwd).toBe('/');
    expect(calls[0]?.timeoutMs).toBe(12345);
  });

  it('delivers the multi-line sweep script via stdin, with command fixed to the single-line "sh -s" (never embeds the script in argv/command)', async () => {
    // Regression test: the elevated `sudo -u <user> --preserve-env=... -i sh
    // -c <command>` path re-joins its trailing argv into a single command
    // line for the target login shell, collapsing embedded newlines in a
    // multi-line `command` string -- this broke `for ... do ... done` on a
    // real dogfood host (observed: `sh: 1: Syntax error: "do" unexpected`).
    // `command` must therefore stay single-line ("sh -s", which reads its
    // script from stdin); the actual multi-line script travels over
    // `stdin`, a channel immune to the argv-join.
    const calls: Array<Parameters<typeof runAsUser>[0]> = [];
    const fake: typeof runAsUser = async (opts) => {
      calls.push(opts);
      return okResult({ stdout: 'SWEPT=0\n' });
    };

    await sweepOrphanProcesses('sess-1', 'target-user', {
      runAsUserImpl: fake,
      killGraceMs: 2000,
    });

    expect(calls[0]?.command).toBe('sh -s');
    expect(calls[0]?.command).not.toContain('\n');
    expect(calls[0]?.stdin).toBe(buildSweepScript('sess-1', { killGraceMs: 2000 }));
  });

  it('forwards procRootOverride as a SWEEP_PROC_ROOT env var', async () => {
    const calls: Array<Parameters<typeof runAsUser>[0]> = [];
    const fake: typeof runAsUser = async (opts) => {
      calls.push(opts);
      return okResult({ stdout: 'SWEPT=0\n' });
    };

    await sweepOrphanProcesses('sess-1', null, {
      runAsUserImpl: fake,
      procRootOverride: '/tmp/scratch-root',
    });

    expect(calls[0]?.env).toEqual({ SWEEP_PROC_ROOT: '/tmp/scratch-root' });
  });

  it('omits env entirely when procRootOverride is not provided', async () => {
    const calls: Array<Parameters<typeof runAsUser>[0]> = [];
    const fake: typeof runAsUser = async (opts) => {
      calls.push(opts);
      return okResult({ stdout: 'SWEPT=0\n' });
    };

    await sweepOrphanProcesses('sess-1', null, { runAsUserImpl: fake });

    expect(calls[0]?.env).toBeUndefined();
  });

  it('killedCount reflects the parsed SWEPT count from stdout', async () => {
    const fake: typeof runAsUser = async () => okResult({ stdout: 'SWEPT=7\n' });

    const result = await sweepOrphanProcesses('sess-1', null, { runAsUserImpl: fake });

    expect(result.killedCount).toBe(7);
    expect(result.raw.stdout).toBe('SWEPT=7\n');
  });

  it('does not throw on a non-zero exit code -- returns the raw result unchanged', async () => {
    const fake: typeof runAsUser = async () =>
      okResult({ exitCode: 1, stderr: 'boom', stdout: '' });

    let thrown: unknown;
    let result: Awaited<ReturnType<typeof sweepOrphanProcesses>> | undefined;
    try {
      result = await sweepOrphanProcesses('sess-1', null, { runAsUserImpl: fake });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(result?.killedCount).toBe(0);
    expect(result?.raw.exitCode).toBe(1);
    expect(result?.raw.stderr).toBe('boom');
  });

  it('does not throw on a timed-out result -- returns the raw result unchanged', async () => {
    const fake: typeof runAsUser = async () =>
      okResult({ timedOut: true, exitCode: 137, stdout: '' });

    let thrown: unknown;
    let result: Awaited<ReturnType<typeof sweepOrphanProcesses>> | undefined;
    try {
      result = await sweepOrphanProcesses('sess-1', null, { runAsUserImpl: fake });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(result?.killedCount).toBe(0);
    expect(result?.raw.timedOut).toBe(true);
  });

  it('does not throw on malformed stdout and returns killedCount 0', async () => {
    const fake: typeof runAsUser = async () => okResult({ stdout: 'not-well-formed' });

    const result = await sweepOrphanProcesses('sess-1', null, { runAsUserImpl: fake });

    expect(result.killedCount).toBe(0);
  });

  it('throws synchronously on an empty sessionId without invoking runAsUserImpl', async () => {
    let called = false;
    const fake: typeof runAsUser = async () => {
      called = true;
      return okResult();
    };

    let thrown: unknown;
    try {
      await sweepOrphanProcesses('', 'target-user', { runAsUserImpl: fake });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(called).toBe(false);
  });
});

// ============================================================
// Tier B — real-process (Bun.spawn directly against real /proc, bypassing
// runAsUser/elevation entirely -- same-user only, exactly like
// packages/embedded-agent/src/tools/__tests__/bash.test.ts's trap-TERM
// test). These tests exercise buildSweepScript's actual shell-script
// behavior in isolation from the runAsUser plumbing, which Tier A already
// covers via injected fakes.
// ============================================================

describe('buildSweepScript (real-process, same-user)', () => {
  // Short grace period keeps the suite fast; still non-zero so the
  // grace-then-escalate behavior is actually exercised (see the trap-TERM
  // test below), matching the "no partial polarity" spirit -- a zero grace
  // period would make the escalation branch untestable.
  const TEST_KILL_GRACE_MS = 300;

  const spawnedPids: number[] = [];

  afterEach(async () => {
    // Best-effort cleanup: kill anything this test spawned and did not
    // already reap, so a failed assertion never leaks a real process from
    // the CI runner. Verified, not assumed -- matches
    // scripts/smoke/check-kill-as-user.ts's cleanup discipline.
    const pending = spawnedPids.splice(0, spawnedPids.length);
    for (const pid of pending) {
      if (await procAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // best-effort
        }
      }
    }
  });

  function uniqueSessionId(label: string): string {
    return `sweep-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Liveness check via `Bun.file(...).exists()` on `/proc/<pid>/environ`,
   * NOT `node:fs`'s `existsSync`. `packages/server/src/__tests__/utils/mock-fs-helper.ts`
   * performs a process-global `mock.module('node:fs', ...)` (memfs) at
   * import time; once ANY test file in this bun:test process imports it
   * (many do), every OTHER test file's `node:fs` / `node:fs/promises`
   * calls silently redirect to the fake in-memory filesystem for the rest
   * of the process's lifetime -- see `.claude/rules/testing.md` Anti-Pattern
   * #2. `Bun.file()` is a Bun-native API outside that module namespace and
   * stays backed by the real OS filesystem regardless of what other test
   * files in this run have mocked. `environ` (rather than the bare `/proc/<pid>`
   * directory) is used because `Bun.file()` is file-oriented -- `.exists()`
   * on a directory path always resolves `false` even when the directory is
   * real, but the environ file reliably exists exactly while the process
   * is alive and disappears immediately (no zombie-lag) once it exits.
   */
  async function procAlive(pid: number): Promise<boolean> {
    return Bun.file(`/proc/${pid}/environ`).exists();
  }

  async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await procAlive(pid))) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !(await procAlive(pid));
  }

  /** Real `mkdir -p` via a subprocess -- immune to `node:fs` mock pollution (see `procAlive` docs above). */
  async function mkdirReal(dir: string): Promise<void> {
    const proc = Bun.spawn(['mkdir', '-p', dir]);
    const code = await proc.exited;
    if (code !== 0) throw new Error(`mkdir -p ${dir} failed (exit ${code})`);
  }

  /** Real `chmod` via a subprocess -- immune to `node:fs` mock pollution. */
  async function chmodReal(target: string, mode: string): Promise<void> {
    const proc = Bun.spawn(['chmod', mode, target]);
    await proc.exited;
  }

  /** Real `rm -rf` via a subprocess -- immune to `node:fs` mock pollution. */
  async function rmRecursiveReal(target: string): Promise<void> {
    const proc = Bun.spawn(['rm', '-rf', target]);
    await proc.exited;
  }

  /**
   * Spawns a real, trackable `sleep` process directly (no shell wrapper --
   * `Bun.spawn(['sleep', ...])` execs the binary in place, producing
   * exactly one OS process with no forked child, unlike
   * `Bun.spawn(['sh', '-c', 'sleep ...'])` which dash forks a child for).
   * `env` is layered over the current process env when provided; omitting
   * it produces an intentionally UNMARKED control process.
   */
  function spawnMarked(env: Record<string, string> | undefined, seconds = 300): number {
    const proc = Bun.spawn(['sleep', String(seconds)], {
      env: env ? { ...process.env, ...env } : { ...process.env },
    });
    spawnedPids.push(proc.pid);
    return proc.pid;
  }

  async function runSweepScript(
    sessionId: string,
    opts: { killGraceMs?: number; procRootOverride?: string; extraEnv?: Record<string, string> } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string; killedCount: number }> {
    const script = buildSweepScript(sessionId, { killGraceMs: opts.killGraceMs ?? TEST_KILL_GRACE_MS });
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (opts.procRootOverride) env.SWEEP_PROC_ROOT = opts.procRootOverride;
    if (opts.extraEnv) Object.assign(env, opts.extraEnv);

    const proc = Bun.spawn(['sh', '-c', script, 'sh'], { stdout: 'pipe', stderr: 'pipe', env });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, killedCount: parseSweptCount(stdout) };
  }

  it('0 candidates: sweeps nothing and completes cleanly', async () => {
    const sessionId = uniqueSessionId('zero');

    const result = await runSweepScript(sessionId);

    expect(result.exitCode).toBe(0);
    expect(result.killedCount).toBe(0);
  });

  it('1 candidate: the marked process is killed', async () => {
    const sessionId = uniqueSessionId('one');
    const pid = spawnMarked({ AGENT_CONSOLE_SESSION_ID: sessionId });
    await new Promise((r) => setTimeout(r, 200));
    expect(await procAlive(pid)).toBe(true);

    const result = await runSweepScript(sessionId);

    expect(result.exitCode).toBe(0);
    expect(result.killedCount).toBe(1);
    expect(await waitUntilGone(pid, 3000)).toBe(true);
  });

  it('N candidates: all marked processes are killed', async () => {
    const sessionId = uniqueSessionId('many');
    const pids = [
      spawnMarked({ AGENT_CONSOLE_SESSION_ID: sessionId }),
      spawnMarked({ AGENT_CONSOLE_SESSION_ID: sessionId }),
      spawnMarked({ AGENT_CONSOLE_SESSION_ID: sessionId }),
    ];
    await new Promise((r) => setTimeout(r, 200));

    const result = await runSweepScript(sessionId);

    expect(result.exitCode).toBe(0);
    expect(result.killedCount).toBe(3);
    for (const pid of pids) {
      expect(await waitUntilGone(pid, 3000)).toBe(true);
    }
  });

  it('negative: an unmarked control process survives the sweep', async () => {
    const sessionId = uniqueSessionId('neg-unmarked');
    const controlPid = spawnMarked(undefined);
    await new Promise((r) => setTimeout(r, 200));

    const result = await runSweepScript(sessionId);

    expect(result.killedCount).toBe(0);
    expect(await procAlive(controlPid)).toBe(true);
  });

  it('negative: a process marked with a DIFFERENT session ID survives the sweep', async () => {
    const targetSessionId = uniqueSessionId('neg-diff-target');
    const otherSessionId = uniqueSessionId('neg-diff-other');
    const controlPid = spawnMarked({ AGENT_CONSOLE_SESSION_ID: otherSessionId });
    await new Promise((r) => setTimeout(r, 200));

    const result = await runSweepScript(targetSessionId);

    expect(result.killedCount).toBe(0);
    expect(await procAlive(controlPid)).toBe(true);
  });

  it('escalates to SIGKILL for a marked process that ignores SIGTERM (trap TERM)', async () => {
    const sessionId = uniqueSessionId('trap-term');
    const trapProc = Bun.spawn(['sh', '-c', "trap '' TERM; while :; do :; done"], {
      env: { ...process.env, AGENT_CONSOLE_SESSION_ID: sessionId },
    });
    spawnedPids.push(trapProc.pid);
    await new Promise((r) => setTimeout(r, 200));
    expect(await procAlive(trapProc.pid)).toBe(true);

    const sweepPromise = runSweepScript(sessionId);

    // Mid-grace-window assertion: SIGTERM was sent and ignored, so the
    // process must still be alive shortly before the grace period elapses.
    // This proves the process survives the TERM-only window rather than
    // just happening to die at some point during the whole sweep call.
    await new Promise((r) => setTimeout(r, TEST_KILL_GRACE_MS - 100));
    expect(await procAlive(trapProc.pid)).toBe(true);

    const result = await sweepPromise;

    expect(result.exitCode).toBe(0);
    expect(result.killedCount).toBe(1);
    expect(await waitUntilGone(trapProc.pid, 3000)).toBe(true);
  });

  it('self-exclusion: the sweep script never signals its own pid, even when its own env matches the marker it is searching for', async () => {
    const sessionId = uniqueSessionId('self');

    // The sweep script's OWN process legitimately carries the very marker
    // it is searching for (AGENT_CONSOLE_SESSION_ID=sessionId is set on
    // this spawn's own env). If self-exclusion were broken, the script
    // would send itself SIGTERM mid-loop and die before ever printing
    // SWEPT= -- a strong, deterministic proof of self-exclusion.
    const result = await runSweepScript(sessionId, {
      extraEnv: { AGENT_CONSOLE_SESSION_ID: sessionId },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SWEPT=');
    expect(result.killedCount).toBe(0);
  });

  it('environ read failures (ENOENT/EACCES) in the scan do not crash the loop, and a real matching entry later in glob order is still killed', async () => {
    const sessionId = uniqueSessionId('scratch');
    // Manually-constructed unique path (not `fsPromises.mkdtemp`) + real
    // `mkdir`/`Bun.write` primitives below -- see `procAlive`'s doc comment
    // above for why `node:fs`/`node:fs/promises` are avoided in this file.
    const scratchDir = path.join(tmpdir(), `orphan-sweep-test-${randomUUID()}`);
    const badEnviron = path.join(scratchDir, '888888', 'environ');

    // Real process to be discovered via the scratch override root. Its own
    // real /proc/<pid>/environ is irrelevant to this test -- only the
    // constructed override entry (below) needs to match, since the scan
    // phase reads from SWEEP_PROC_ROOT, not the real /proc.
    const realPid = spawnMarked(undefined);
    await new Promise((r) => setTimeout(r, 200));

    try {
      // (a) ENOENT/race simulation: a numeric pid directory with no
      // `environ` file. The glob itself will not produce this path (no
      // file exists there), so this entry is silently absent from
      // iteration -- documents the expected shape rather than exercising
      // a distinct code branch.
      await mkdirReal(path.join(scratchDir, '999999'));

      // (b) EACCES simulation: an `environ` file that exists but is
      // unreadable by this test process. `Bun.write` auto-creates parent
      // directories, so no separate mkdir call is needed here.
      await Bun.write(badEnviron, `AGENT_CONSOLE_SESSION_ID=${sessionId}\0`);
      await chmodReal(badEnviron, '000');

      // (c) a real running process's pid, with a constructed matching
      // `environ` file at the override root -- NUL-separated KEY=VALUE
      // records, mirroring the real /proc/<pid>/environ format.
      const realEnviron = path.join(scratchDir, String(realPid), 'environ');
      await Bun.write(realEnviron, `AGENT_CONSOLE_SESSION_ID=${sessionId}\0OTHER=1\0`);

      const result = await runSweepScript(sessionId, { procRootOverride: scratchDir });

      expect(result.exitCode).toBe(0);
      expect(result.killedCount).toBe(1);
      expect(await waitUntilGone(realPid, 3000)).toBe(true);
    } finally {
      await chmodReal(badEnviron, '600');
      await rmRecursiveReal(scratchDir);
    }
  });
});
