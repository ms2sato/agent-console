/**
 * Generic process-tree utilities for signaling an entire process tree, not
 * just its root pid.
 *
 * Why this exists: killing a PTY's root pid (the shell) does not reach
 * processes the shell launched into their own process group via job control
 * (e.g. an interactively-typed foreground command). Those descendants share
 * the PTY's session but live in a different process group, so a single
 * `kill(rootPid)` never signals them -- they get reparented to init and leak
 * as orphans once the shell exits. Walking the OS process table's ppid graph
 * lets callers signal every descendant explicitly, in addition to the root.
 *
 * This module is intentionally free of any worker/session-specific
 * concerns -- it operates purely on pids and the OS process table.
 */

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
}

/**
 * Pure parser for `ps -Ao pid,ppid` output: a header line followed by
 * whitespace-separated `pid ppid` columns (right-aligned with variable
 * padding on both GNU and BSD `ps`). Lines that don't parse into two valid
 * integers are skipped rather than throwing, so a single malformed/truncated
 * line does not abort the whole read.
 */
export function parseProcessTable(output: string): ProcessTableEntry[] {
  const lines = output.split('\n');
  const entries: ProcessTableEntry[] = [];

  // First non-empty line is the header (e.g. "  PID  PPID"); skip it.
  let sawHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (!sawHeader) {
      sawHeader = true;
      continue;
    }

    const columns = trimmed.split(/\s+/);
    if (columns.length < 2) {
      continue;
    }
    const pid = Number(columns[0]);
    const ppid = Number(columns[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    entries.push({ pid, ppid });
  }

  return entries;
}

/**
 * Pure BFS over the ppid graph. Returns all transitive descendants of
 * `rootPid` (NOT including `rootPid` itself). Guards against revisiting a
 * pid so pid reuse or an accidental cycle in the input table cannot cause an
 * infinite loop.
 */
export function collectDescendantPids(rootPid: number, table: ProcessTableEntry[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const { pid, ppid } of table) {
    const siblings = childrenByParent.get(ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      childrenByParent.set(ppid, [pid]);
    }
  }

  const descendants: number[] = [];
  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      if (visited.has(child)) {
        continue;
      }
      visited.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }

  return descendants;
}

/**
 * `ps -Ao pid,ppid` normally completes in well under 100ms; 5s is a generous
 * safety margin against a wedged/hung `ps`, not a normal-path latency
 * budget. `killWorker` awaits `readProcessTable` before `pty.kill()`, so an
 * unbounded hang here would stall the entire kill cleanup path.
 */
const READ_PROCESS_TABLE_TIMEOUT_MS = 5000;

/**
 * I/O: spawns `ps -Ao pid,ppid` and returns the parsed process table.
 * `-A` (all processes) and `-o pid,ppid` (custom columns) are supported by
 * both GNU `ps` (Linux) and BSD `ps` (macOS), and `procps` is installed in
 * the production Docker image.
 *
 * Bounded by `timeout`, which kills the process with `killSignal` (default
 * `SIGTERM`) if it hasn't exited in time -- Bun handles the timer itself, no
 * manual race needed. `stderr` is ignored rather than piped: we don't
 * consume it, and an unconsumed pipe can fill up and block the child.
 * `spawnCommand` is a test seam (mirrors the `readTableImpl` seam on
 * `listDescendantPids` one level up) for exercising the timeout/failure path
 * without depending on a real `ps` hang.
 */
export async function readProcessTable(
  spawnCommand: string[] = ['ps', '-Ao', 'pid,ppid'],
): Promise<ProcessTableEntry[]> {
  try {
    const proc = Bun.spawn(spawnCommand, {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: READ_PROCESS_TABLE_TIMEOUT_MS,
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return parseProcessTable(stdout);
  } catch {
    // Spawn failure or a read error -- behave like an empty process table,
    // matching the existing safe fallback (collectDescendantPids returns []).
    return [];
  }
}

/**
 * Reads the current process table and returns the descendant pids of
 * `rootPid` (does NOT include `rootPid`). Does not send any signal --
 * signaling is a separate, side-effect-free-to-call-repeatedly step (see
 * `signalPids`) so callers can snapshot once and signal twice (SIGTERM then
 * escalate to SIGKILL) without re-walking the tree and risking a reparent
 * race once the root has already been killed.
 */
export async function listDescendantPids(
  rootPid: number,
  readTableImpl: typeof readProcessTable = readProcessTable,
): Promise<number[]> {
  const table = await readTableImpl();
  return collectDescendantPids(rootPid, table);
}

/**
 * Sends `signal` to each pid in `pids`. Swallows "no such process" (the pid
 * already exited) per-pid so a partially-exited descendant set never throws;
 * any other unexpected error is also swallowed since this is a best-effort
 * cleanup step, not a correctness-critical one.
 */
export function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited (ESRCH) or otherwise unsignalable -- best effort.
    }
  }
}
