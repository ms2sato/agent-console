import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { bashTool, runBash } from '../bash.js';
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
});
