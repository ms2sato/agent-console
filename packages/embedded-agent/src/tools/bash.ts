/**
 * Builtin `Bash` tool: executes a shell command via `sh -c`, confined to the
 * session's locationPath as cwd. Opt-in only (excluded from
 * DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS) — see docs/design/embedded-agent-worker.md
 * Part II.
 *
 * Uses `node:child_process` `spawn` with `detached: true` so the spawned `sh`
 * becomes its own process-group leader. On timeout, the ENTIRE process group
 * is signaled (`process.kill(-pid, ...)`, note the negative pid), so
 * backgrounded/detached grandchildren (e.g. `nohup foo &` inside a
 * non-interactive `sh -c` script, where job control is off and `&` does not
 * fork a new pgid) are killed along with the shell itself.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';
import { truncateToBytes } from '../truncate.js';
import { buildBashEnv } from './env-cleaner.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1;
const KILL_GRACE_MS = 2_000;
const OUTPUT_MAX_BYTES = 16 * 1024;

interface BashArgs {
  command: string;
  timeoutMs: number;
}

export interface RunBashOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /**
   * Optional turn-level abort signal (sourced from `AgentLoop`'s per-turn
   * `AbortController`, threaded via `BuiltinTool.execute`'s third parameter).
   * Firing it kills the process group via the same SIGTERM -> grace ->
   * SIGKILL sequence used on timeout; final settlement still happens from
   * `child.on('close', ...)` once the kill actually takes effect.
   */
  signal?: AbortSignal;
}

export interface RunBashResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function parseArgs(args: unknown): { ok: true; value: BashArgs } | { ok: false; message: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.command !== 'string') {
    return { ok: false, message: 'command is required and must be a string' };
  }
  if (a.timeout !== undefined && typeof a.timeout !== 'number') {
    return { ok: false, message: 'timeout must be a number' };
  }
  if (a.description !== undefined && typeof a.description !== 'string') {
    return { ok: false, message: 'description must be a string' };
  }
  const timeoutMs =
    typeof a.timeout === 'number'
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, a.timeout))
      : DEFAULT_TIMEOUT_MS;
  return { ok: true, value: { command: a.command, timeoutMs } };
}

/**
 * Spawns `sh -c command` as a detached process-group leader and resolves once
 * the child's stdio streams have closed. Never rejects/throws: infra failures
 * (spawn error, timeout, abort) are reported via the resolved
 * `{ ok: false, ... }` shape so callers don't need a try/catch around this
 * call.
 *
 * @internal Exported for testing (timeout / abort / process-group-kill polarity).
 */
export function runBash(command: string, opts: RunBashOptions): Promise<RunBashResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder('utf-8');
    let stderr = '';
    let stderrBytes = 0;
    const stderrDecoder = new StringDecoder('utf-8');
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < OUTPUT_MAX_BYTES) {
        stdout += stdoutDecoder.write(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < OUTPUT_MAX_BYTES) {
        stderr += stderrDecoder.write(chunk);
        stderrBytes += chunk.length;
      }
    });

    // SIGTERM the entire process group, then escalate to SIGKILL after
    // KILL_GRACE_MS if it's still alive. Shared by the timeout path and the
    // abort path below so both signal sources drive the exact same sequence.
    function killProcessGroup(): void {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // ESRCH: process group already gone.
        }
      }
      killTimer = setTimeout(() => {
        if (settled || child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ESRCH: process group already gone.
        }
      }, KILL_GRACE_MS);
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, opts.timeoutMs);

    function onAbort(): void {
      if (settled || aborted) return;
      aborted = true;
      killProcessGroup();
    }

    opts.signal?.addEventListener('abort', onAbort);
    if (opts.signal?.aborted) {
      // The signal fired before runBash was even called (or synchronously
      // during spawn, before the listener above could observe the event) —
      // the 'abort' event will not fire again, so trigger the same kill path
      // directly.
      onAbort();
    }

    function settle(result: Omit<RunBashResult, 'stdout' | 'stderr'>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Flush each decoder exactly once to catch any trailing incomplete
      // multi-byte sequence still buffered inside it, BEFORE truncation.
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({
        ...result,
        stdout: truncateToBytes(stdout, OUTPUT_MAX_BYTES).text,
        stderr: truncateToBytes(stderr, OUTPUT_MAX_BYTES).text,
      });
    }

    child.on('error', (err) => {
      stderr += `\n[Failed to spawn command: ${err.message}]`;
      settle({
        ok: false,
        exitCode: null,
        timedOut: false,
        aborted,
      });
    });

    child.on('close', (code) => {
      settle({
        ok: !timedOut && !aborted,
        exitCode: code,
        timedOut,
        aborted,
      });
    });
  });
}

/**
 * Renders a `RunBashResult` into the single string the wire protocol carries.
 * `result.stdout` / `result.stderr` are already bounded to OUTPUT_MAX_BYTES by
 * `runBash`, so no further truncation happens here.
 */
export function formatBashResult(result: RunBashResult, timeoutMs: number): string {
  let output = '';
  if (result.stdout.length > 0) {
    output += result.stdout;
  }
  if (result.stderr.length > 0) {
    output += `\n\n[stderr]\n${result.stderr}`;
  }
  if (result.aborted) {
    output += `\n\n[Command aborted and its process group was terminated.]`;
  } else if (result.timedOut) {
    output += `\n\n[Command timed out after ${timeoutMs}ms and was killed (process group terminated).]`;
  } else if (result.exitCode === null) {
    output += `\n\n[Killed by signal]`;
  } else if (result.exitCode !== 0) {
    output += `\n\n[Exit code: ${result.exitCode}]`;
  }
  return output.length > 0 ? output : '(no output)';
}

async function execute(args: unknown, ctx: BuiltinToolContext, signal?: AbortSignal): Promise<BuiltinToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { ok: false, result: parsed.message };
  }
  const { command, timeoutMs } = parsed.value;

  const result = await runBash(command, {
    cwd: ctx.locationPath,
    env: buildBashEnv(),
    timeoutMs,
    signal,
  });

  return { ok: result.ok, result: formatBashResult(result, timeoutMs) };
}

export const bashTool: BuiltinTool = {
  name: 'Bash',
  definition: {
    name: 'Bash',
    description:
      'Execute a shell command via sh -c. The command runs with a timeout ' +
      '(default 120000ms, max 600000ms); on timeout the entire process group is killed ' +
      '(SIGTERM, then SIGKILL after a grace period), so backgrounded/detached children ' +
      'do not survive a timeout. Output (stdout/stderr) is truncated to 16 KiB.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default 120000, max 600000)',
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does, 5-10 words',
        },
      },
      required: ['command'],
    },
  },
  execute,
};
