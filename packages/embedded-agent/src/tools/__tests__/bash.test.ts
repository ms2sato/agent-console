import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { bashTool, runBash, formatBashResult } from '../bash.js';
import { buildBashEnv } from '../env-cleaner.js';

describe('bashTool', () => {
  let locationPath: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-bash-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
  });

  it('executes a command and returns stdout', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toContain('hello');
  });

  it('rejects a missing command argument', async () => {
    const result = await bashTool.execute({}, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('command is required and must be a string');
  });

  it('treats a non-zero exit code as a normal (non-failing) result', async () => {
    const result = await bashTool.execute({ command: 'exit 3' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toContain('Exit code: 3');
  });

  it('resolves with timedOut=true / ok=false instead of throwing when the command exceeds the timeout', async () => {
    const result = await runBash('sleep 0.5', {
      cwd: locationPath,
      env: buildBashEnv(),
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('kills the entire process group on timeout, including a backgrounded grandchild that escaped via &', async () => {
    const pidFile = path.join(locationPath, 'bg.pid');
    const start = Date.now();

    const result = await runBash(
      `sh -c 'nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}'; sleep 5`,
      { cwd: locationPath, env: buildBashEnv(), timeoutMs: 500 },
    );
    const elapsedMs = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Well before the inner `sleep 5` would have completed on its own — proves
    // the process group was actually killed, not just that the outer await
    // eventually returned.
    expect(elapsedMs).toBeLessThan(3000);

    // Brief grace window for signal delivery to actually land.
    await new Promise((r) => setTimeout(r, 300));

    const pid = parseInt((await fsPromises.readFile(pidFile, 'utf-8')).trim(), 10);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('truncates stdout to 16 KiB', async () => {
    const result = await runBash("head -c 20000 /dev/zero | tr '\\0' 'x'", {
      cwd: locationPath,
      env: buildBashEnv(),
      timeoutMs: 5000,
    });

    expect(result.stdout.length).toBe(16384);
  });

  it('bounds accumulation across many small chunks arriving over time, not just one large burst', async () => {
    // `head -c 20000` above can arrive as a single 'data' event (well under the
    // OS pipe buffer size), so it never exercises the per-chunk
    // `stdoutBytes < OUTPUT_MAX_BYTES` guard flipping from true to false on a
    // later chunk. This command emits 20 separate 2000-byte writes with a
    // sleep between each, forcing 20 distinct 'data' events (~40 KiB total,
    // well over the 16 KiB cap) spread across roughly a second. Note:
    // `truncateToBytes` at settle() always produces the correct final 16 KiB
    // result regardless of how much `stdout` grew internally, so this
    // assertion alone cannot distinguish "bounded per-chunk accumulation"
    // from "unbounded accumulation then truncated" purely from the outside --
    // it exercises the guard's skip branch across multiple events, while the
    // actual memory-growth bound is a property of the implementation.
    const result = await runBash(
      "for i in $(seq 1 20); do head -c 2000 /dev/zero | tr '\\0' 'x'; sleep 0.05; done",
      { cwd: locationPath, env: buildBashEnv(), timeoutMs: 5000 },
    );

    expect(result.stdout.length).toBe(16384);
  });

  it('does not append "[Exit code: null]" when the process is killed by a signal instead of timing out', async () => {
    const result = await bashTool.execute({ command: 'kill -9 $$' }, { locationPath });

    expect(result.result).not.toContain('Exit code: null');
    // Strengthened per the architect follow-up (Issue #1052): external
    // signal-death now surfaces an explicit marker instead of silence.
    expect(result.result).toContain('[Killed by signal]');
  });

  it('kills the process group and resolves {ok:false, aborted:true} when the caller aborts mid-execution', async () => {
    const pidFile = path.join(locationPath, 'abort.pid');
    const controller = new AbortController();

    const runPromise = runBash(`echo $$ > ${pidFile}; sleep 300`, {
      cwd: locationPath,
      env: buildBashEnv(),
      timeoutMs: 600_000,
      signal: controller.signal,
    });

    // Wait for the pid file to appear so we know the process actually started
    // before aborting (otherwise we could abort before spawn() has a pid).
    let pid: number | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        pid = parseInt((await fsPromises.readFile(pidFile, 'utf-8')).trim(), 10);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pid).toBeDefined();

    const start = Date.now();
    controller.abort();
    const result = await runPromise;
    const elapsedMs = Date.now() - start;

    expect(result).toMatchObject({ ok: false, aborted: true, timedOut: false });
    // Worst case: 2s grace + escalation, well under the 300s sleep.
    expect(elapsedMs).toBeLessThan(2500);

    let alive = true;
    try {
      process.kill(pid as number, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('kills the process and resolves correctly when the signal is already aborted before runBash is called', async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    const result = await runBash('sleep 300', {
      cwd: locationPath,
      env: buildBashEnv(),
      timeoutMs: 600_000,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - start;

    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(2500);
  });

  it('reassembles a multi-byte UTF-8 character whose bytes arrive in separate data events', async () => {
    // 'é' encodes to 2 bytes in UTF-8 (0xC3 0xA9 = octal \303 \251). Two
    // separate `printf` invocations with a `sleep` between them force two
    // distinct 'data' events (mirroring the "bounds accumulation" test's
    // technique above), defeating OS pipe coalescing and exercising the
    // StringDecoder boundary-carry logic. POSIX printf's `\xHH` escape is not
    // portable across `sh` implementations, so octal `\NNN` is used instead.
    const result = await runBash("printf '\\303'; sleep 0.05; printf '\\251'", {
      cwd: locationPath,
      env: buildBashEnv(),
      timeoutMs: 5000,
    });

    expect(result.stdout).toBe('é');
    expect(result.stdout).not.toContain('�');
  });

  it('does not leak AGENT_CONSOLE_*-prefixed env vars (or their values) into the spawned command', async () => {
    const previous = process.env.AGENT_CONSOLE_MCP_TOKEN;
    process.env.AGENT_CONSOLE_MCP_TOKEN = 'secret-token-xyz';
    try {
      const result = await bashTool.execute({ command: 'env' }, { locationPath });

      expect(result.result).not.toContain('secret-token-xyz');
      // Assert no *key* in the printed `env` output starts with AGENT_CONSOLE_
      // (a leaked var, i.e. a line shaped `AGENT_CONSOLE_FOO=...`). A plain
      // substring check on the whole blob is too brittle here: this test can
      // itself run inside a delegated/elevated agent-console session whose
      // ambient SUDO_COMMAND env var legitimately contains the literal text
      // "AGENT_CONSOLE_" (from the sudo invocation's own `export
      // AGENT_CONSOLE_SESSION_ID=...` command line) without that being a leak
      // of buildBashEnv's key-based filtering.
      expect(result.result).not.toMatch(/(^|\n)AGENT_CONSOLE_[A-Za-z0-9_]*=/);
      expect(result.result).toContain('PATH=');
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_CONSOLE_MCP_TOKEN;
      } else {
        process.env.AGENT_CONSOLE_MCP_TOKEN = previous;
      }
    }
  });

  it('formats an aborted result with the abort marker, independent of exit code', () => {
    const output = formatBashResult(
      { ok: false, exitCode: null, stdout: 'partial output', stderr: '', timedOut: false, aborted: true },
      5000,
    );

    expect(output).toContain('partial output');
    expect(output).toContain('[Command aborted and its process group was terminated.]');
    // aborted takes priority over the exitCode===null branch in the else-if chain.
    expect(output).not.toContain('[Killed by signal]');
  });

  it('formats stderr output alongside the exit-code / signal-kill marker', () => {
    const withExitCode = formatBashResult(
      { ok: true, exitCode: 3, stdout: '', stderr: 'boom', timedOut: false, aborted: false },
      5000,
    );
    expect(withExitCode).toContain('[stderr]\nboom');
    expect(withExitCode).toContain('[Exit code: 3]');

    const withoutExitCode = formatBashResult(
      { ok: false, exitCode: null, stdout: '', stderr: 'boom', timedOut: false, aborted: false },
      5000,
    );
    expect(withoutExitCode).toContain('[stderr]\nboom');
    expect(withoutExitCode).toContain('[Killed by signal]');
  });

  it('escalates to SIGKILL after the grace period when the process ignores SIGTERM', async () => {
    const pidFile = path.join(locationPath, 'ignore-term.pid');
    const start = Date.now();

    const result = await runBash(`trap '' TERM; echo $$ > ${pidFile}; while :; do :; done`, {
      cwd: locationPath,
      env: buildBashEnv(),
      timeoutMs: 500,
    });
    const elapsedMs = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    // The process ignores SIGTERM (trap '' TERM), so it can only have died via
    // the SIGKILL escalation fired KILL_GRACE_MS after the SIGTERM -- proves
    // the escalation branch actually ran, not just that SIGTERM alone worked.
    // Bounds are widened (vs. the raw ~2500ms expectation) to tolerate CI
    // scheduling jitter around the real setTimeout-driven grace window.
    expect(elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(elapsedMs).toBeLessThan(6000);

    // Brief grace window for signal delivery to actually land.
    await new Promise((r) => setTimeout(r, 300));

    const pid = parseInt((await fsPromises.readFile(pidFile, 'utf-8')).trim(), 10);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('surfaces a spawn failure (e.g. ENOENT from a nonexistent cwd) as {ok:false} instead of throwing', async () => {
    // Exercises the real `child.on('error', ...)` path via an actual spawn
    // failure (nonexistent cwd) rather than mocking `spawn`, per this repo's
    // "mock at the lowest level" testing rule -- a real OS-level failure is
    // lower-level than mocking the child_process module.
    const result = await runBash('echo hi', {
      cwd: path.join(locationPath, 'this-directory-does-not-exist'),
      env: buildBashEnv(),
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.stderr).toContain('Failed to spawn command');
  });

  it('rejects non-string/non-number typed timeout and description arguments', async () => {
    const badTimeout = await bashTool.execute({ command: 'echo hi', timeout: 'not-a-number' }, { locationPath });
    expect(badTimeout.ok).toBe(false);
    expect(badTimeout.result).toBe('timeout must be a number');

    const badDescription = await bashTool.execute({ command: 'echo hi', description: 42 }, { locationPath });
    expect(badDescription.ok).toBe(false);
    expect(badDescription.result).toBe('description must be a string');
  });
});
