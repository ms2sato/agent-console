/**
 * Tree-wide orphan-process sweep by SESSION_ID env marker.
 *
 * `SessionInitializationService.killOrphanWorkers` only kills processes
 * tracked via a session's persisted `worker.pid` -- the direct PTY wrapper
 * process. Detached / background descendant processes spawned by a worker
 * (e.g. a worker's `bun run dev` child, an MCP subprocess) are never in that
 * PID set and leak forever across server restarts. Every worker process in
 * this codebase already carries `AGENT_CONSOLE_SESSION_ID=<sessionId>` in its
 * environment (set at PTY spawn time in `user-mode.ts`, inherited by every
 * descendant process). This module scans `/proc/[pid]/environ` for that
 * marker, tree-wide, regardless of whether a pid was ever recorded as a
 * `worker.pid`.
 *
 * Multi-user constraint: `/proc/<pid>/environ` for another OS user's process
 * is not readable by the server process (EACCES). The scan (which requires
 * reading `environ` to match) MUST therefore run AS the target user -- a
 * "scan as server, then kill as elevated user" two-step is not possible.
 * This module composes a single POSIX `sh` script that does scan + match +
 * kill in one invocation and hands it to `runAsUser` so the whole thing
 * executes as the resolved session owner, mirroring the elevation semantics
 * of `killAsUser` / `rmRecursiveAsUser`.
 *
 * Strict-thin-wrapper contract (`.claude/rules/elevation-helpers.md`):
 * `sweepOrphanProcesses` does not throw on a non-zero exit code or a
 * timeout -- it returns the underlying `RunAsUserResult` unchanged so the
 * caller decides what a failure means. This module's own caller,
 * `SessionInitializationService`, treats a failed sweep as best-effort and
 * only logs a warn (the already-tested `killOrphanWorkers` path remains the
 * primary cleanup mechanism; this sweep is a broader net on top of it).
 */
import { runAsUser, shellEscape, type RunAsUserResult } from './privilege-elevation.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:orphan-process-sweeper');

/**
 * Grace period between sending SIGTERM to a matched candidate and
 * escalating to SIGKILL if it is still alive. Mirrors
 * `packages/embedded-agent/src/tools/bash.ts`'s `KILL_GRACE_MS`.
 */
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface SweepOrphanProcessesOpts {
  timeoutMs?: number;
  /** DI seam mirroring `rmRecursiveAsUser` / `killAsUser`. */
  runAsUserImpl?: typeof runAsUser;
  /** Grace period (ms) between SIGTERM and SIGKILL escalation. Default 2000ms. */
  killGraceMs?: number;
  /**
   * Test-only override for the `/proc` root used during the SCAN phase
   * (candidate discovery + marker matching). Production always omits this
   * (defaults to real `/proc`). Liveness checks and the post-TERM re-match
   * during the escalation phase always use the real `/proc`, independent of
   * this override -- liveness is a kernel fact, not a function of where the
   * scan looked for markers.
   */
  procRootOverride?: string;
}

export interface SweepOrphanProcessesResult {
  killedCount: number;
  /** Unchanged `RunAsUserResult` -- see strict-thin-wrapper contract above. */
  raw: RunAsUserResult;
}

/**
 * Build the POSIX `sh` sweep script for `sessionId`.
 *
 * Phases:
 * 1. Scan each numeric pid directory's `environ` file under
 *    `$SWEEP_PROC_ROOT` (default `/proc`), excluding the script's own pid
 *    (`$$`). For each candidate whose `environ` file
 *    contains an EXACT `AGENT_CONSOLE_SESSION_ID=<id>` record (matched via
 *    `grep -Fxz`, i.e. a fixed-string whole-record match under NUL-delimited
 *    "lines" -- not a substring match, and not vulnerable to regex
 *    metacharacters in `sessionId`), send SIGTERM immediately in the same
 *    loop iteration (minimizing the PID-reuse race window per candidate) and
 *    remember the pid.
 * 2. After a `killGraceMs` grace period, for each SIGTERM'd pid that is
 *    still alive (checked against the REAL `/proc`, never the scan-phase
 *    override), RE-READ and RE-MATCH its `environ` (defense against PID
 *    reuse: a different process may have taken that pid number during the
 *    grace window and must not be blindly killed) before sending SIGKILL.
 *    A race remains possible inside this re-check window itself; that
 *    residual risk is accepted, same class as a pkill-by-attribute race.
 *    `kill(2)` only sends the signal -- termination is asynchronous -- so a
 *    bounded poll (up to ~1s, in 100ms steps) follows the SIGKILL pass
 *    before tallying, to avoid undercounting a kill that has been sent but
 *    has not yet landed under host scheduling load.
 * 3. Print exactly one `SWEPT=<n>` line: the number of SIGTERM'd pids that
 *    are confirmed gone (real `/proc/$pid` no longer exists) after the
 *    escalation pass.
 *
 * A permission-denied or vanished `environ` read never aborts the loop (no
 * `set -e`; grep's stderr is discarded and a non-zero exit is treated as
 * "no match, move on").
 *
 * @internal Exported for testing.
 */
export function buildSweepScript(sessionId: string, opts: { killGraceMs: number }): string {
  const marker = shellEscape(`AGENT_CONSOLE_SESSION_ID=${sessionId}`);
  const graceSeconds = (opts.killGraceMs / 1000).toString();

  return [
    'set -u',
    'self_pid=$$',
    `marker=${marker}`,
    'proc_root="${SWEEP_PROC_ROOT:-/proc}"',
    'term_pids=""',
    'for envfile in "$proc_root"/[0-9]*/environ; do',
    '  [ -e "$envfile" ] || continue',
    '  pid=${envfile%/environ}',
    '  pid=${pid##*/}',
    '  [ "$pid" = "$self_pid" ] && continue',
    '  if grep -Fxzq -- "$marker" "$envfile" 2>/dev/null; then',
    '    kill -s TERM -- "$pid" 2>/dev/null',
    '    term_pids="$term_pids $pid"',
    '  fi',
    'done',
    'if [ -n "$term_pids" ]; then',
    `  sleep ${graceSeconds}`,
    '  for pid in $term_pids; do',
    '    if [ -d "/proc/$pid" ]; then',
    '      if grep -Fxzq -- "$marker" "/proc/$pid/environ" 2>/dev/null; then',
    '        kill -s KILL -- "$pid" 2>/dev/null',
    '      fi',
    '    fi',
    '  done',
    '  # kill(2) only sends the signal -- SIGKILL termination is asynchronous',
    '  # and, under host scheduling load, can lag the kill() call by up to',
    '  # roughly a second for a CPU-spinning target. Poll briefly (bounded)',
    '  # instead of tallying immediately, so the SWEPT count below does not',
    '  # undercount a kill that has been sent but has not yet landed.',
    '  poll_i=0',
    '  while [ "$poll_i" -lt 10 ]; do',
    '    any_alive=0',
    '    for pid in $term_pids; do',
    '      [ -d "/proc/$pid" ] && any_alive=1',
    '    done',
    '    [ "$any_alive" -eq 0 ] && break',
    '    sleep 0.1',
    '    poll_i=$((poll_i + 1))',
    '  done',
    'fi',
    'killed=0',
    'for pid in $term_pids; do',
    '  [ -d "/proc/$pid" ] || killed=$((killed + 1))',
    'done',
    'echo "SWEPT=$killed"',
    '',
  ].join('\n');
}

/**
 * Parse the `SWEPT=<n>` line printed by {@link buildSweepScript}'s output.
 * Returns 0 on missing or malformed output. Pure -- does not log; callers
 * that want to distinguish "genuinely 0" from "could not parse" should
 * inspect the raw stdout themselves (see {@link sweepOrphanProcesses}).
 *
 * @internal Exported for testing.
 */
export function parseSweptCount(stdout: string): number {
  const matches = [...stdout.matchAll(/^SWEPT=(\d+)\s*$/gm)];
  if (matches.length === 0) return 0;
  const last = matches[matches.length - 1];
  const n = Number(last[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sweep every process (tree-wide, not limited to tracked `worker.pid`
 * values) whose environment carries `AGENT_CONSOLE_SESSION_ID=<sessionId>`,
 * as `username` (elevating via `runAsUser` when necessary).
 *
 * Does NOT throw on a non-zero exit code or a timeout -- see the
 * strict-thin-wrapper contract in the module docs above.
 */
export async function sweepOrphanProcesses(
  sessionId: string,
  username: string | null | undefined,
  opts: SweepOrphanProcessesOpts = {},
): Promise<SweepOrphanProcessesResult> {
  if (sessionId.length === 0) {
    throw new Error('sweepOrphanProcesses: sessionId must be a non-empty string');
  }

  const impl = opts.runAsUserImpl ?? runAsUser;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const script = buildSweepScript(sessionId, { killGraceMs });

  const raw = await impl({
    username,
    command: script,
    cwd: '/',
    timeoutMs: opts.timeoutMs,
    env: opts.procRootOverride ? { SWEEP_PROC_ROOT: opts.procRootOverride } : undefined,
  });

  const killedCount = parseSweptCount(raw.stdout);
  if (killedCount === 0 && !/^SWEPT=\d+\s*$/m.test(raw.stdout)) {
    logger.warn(
      { sessionId, exitCode: raw.exitCode, timedOut: raw.timedOut, stdout: raw.stdout, stderr: raw.stderr },
      'sweepOrphanProcesses: could not find a well-formed SWEPT=<n> line in script output',
    );
  }

  return { killedCount, raw };
}
