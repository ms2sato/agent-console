import { describe, it, expect, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  parseProcessTable,
  collectDescendantPids,
  listDescendantPids,
  signalPids,
  readProcessTable,
  type ProcessTableEntry,
} from '../process-tree.js';

describe('parseProcessTable', () => {
  it('returns [] for header-only input', () => {
    expect(parseProcessTable('  PID  PPID\n')).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parseProcessTable('')).toEqual([]);
  });

  it('parses normal multi-line output', () => {
    const output = '  PID  PPID\n    1     0\n   42     1\n  100    42\n';
    expect(parseProcessTable(output)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 42, ppid: 1 },
      { pid: 100, ppid: 42 },
    ]);
  });

  it('handles extra whitespace / variable right-aligned padding', () => {
    const output = '    PID    PPID\n      7       3\n     99999       1\n';
    expect(parseProcessTable(output)).toEqual([
      { pid: 7, ppid: 3 },
      { pid: 99999, ppid: 1 },
    ]);
  });

  it('skips a line that does not parse cleanly rather than throwing', () => {
    const output = '  PID  PPID\n    1     0\n  garbage line\n   42     1\n';
    expect(() => parseProcessTable(output)).not.toThrow();
    expect(parseProcessTable(output)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 42, ppid: 1 },
    ]);
  });
});

describe('collectDescendantPids', () => {
  it('returns [] for an empty table', () => {
    expect(collectDescendantPids(1, [])).toEqual([]);
  });

  it('returns [] for a root with no children', () => {
    const table: ProcessTableEntry[] = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
    ];
    expect(collectDescendantPids(99, table)).toEqual([]);
  });

  it('returns a single direct child', () => {
    const table: ProcessTableEntry[] = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 99 },
    ];
    expect(collectDescendantPids(1, table)).toEqual([2]);
  });

  it('returns a multi-level chain (grandchild)', () => {
    const table: ProcessTableEntry[] = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 3 },
    ];
    expect(collectDescendantPids(1, table).sort()).toEqual([2, 3, 4]);
  });

  it('returns multiple children at the same level', () => {
    const table: ProcessTableEntry[] = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 1 },
      { pid: 4, ppid: 1 },
    ];
    expect(collectDescendantPids(1, table).sort()).toEqual([2, 3, 4]);
  });

  it('excludes a pid that is NOT an ancestor of rootPid (sibling-tree exclusion)', () => {
    const table: ProcessTableEntry[] = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 }, // descendant of 1
      { pid: 10, ppid: 0 }, // unrelated sibling tree
      { pid: 11, ppid: 10 }, // descendant of the unrelated sibling, NOT of 1
    ];
    const result = collectDescendantPids(1, table);
    expect(result).toEqual([2]);
    expect(result).not.toContain(10);
    expect(result).not.toContain(11);
  });

  it('does not infinite-loop on a cyclic table (defensive guard)', () => {
    const table: ProcessTableEntry[] = [
      { pid: 1, ppid: 2 },
      { pid: 2, ppid: 1 },
    ];
    expect(() => collectDescendantPids(1, table)).not.toThrow();
    expect(collectDescendantPids(1, table).sort()).toEqual([2]);
  });
});

describe('readProcessTable', () => {
  it('returns a non-empty real process table (happy path sanity check)', async () => {
    const table = await readProcessTable();
    expect(table.length).toBeGreaterThan(0);
    // The current test process itself must appear in the real table.
    expect(table.some((entry) => entry.pid === process.pid)).toBe(true);
  });

  it('does not hang past the bounded timeout when the spawned command never exits, and returns [] instead of throwing', async () => {
    const start = Date.now();
    // `sleep 30` never writes to stdout and never exits on its own within the
    // test's own timeout budget below -- if the bounded `timeout` option
    // (added by this fix) did not fire, this call would hang until `sleep`
    // itself exits at 30s, which the outer `it(..., 15000)` budget would
    // catch as a failure either way.
    const table = await readProcessTable(['sleep', '30']);
    const elapsed = Date.now() - start;

    // Comfortably bounded well under `sleep 30`'s own duration, proving the
    // internal timeout fired the kill rather than the process exiting on
    // its own.
    expect(elapsed).toBeLessThan(9000);
    expect(table).toEqual([]);
  }, 15000);

  it('returns [] rather than throwing when the spawned command does not exist', async () => {
    await expect(readProcessTable(['__agent-console-nonexistent-command__'])).resolves.toEqual([]);
  });
});

/**
 * Real-process reproduction of the underlying leak mechanism: a process
 * gets SIGTERM'd, but a descendant that job-control put into a DIFFERENT
 * process group (same shape as a shell launching a foreground job) is not
 * reached by that single signal and survives.
 *
 * `setsid` (coreutils) starts B in a new session+process-group while B's
 * ppid still resolves to A at the OS level -- this reproduces "child
 * gets signalled, grandchild-in-new-pgid does not" without needing a real
 * interactive shell or PTY.
 */
describe('process-tree real-process reproduction (job-control pgid leak)', () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawned) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // best-effort cleanup, already exited
        }
      }
    }
    spawned.length = 0;
  });

  async function waitForFile(path: string, timeoutMs = 3000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const file = Bun.file(path);
      if (await file.exists()) {
        const text = await file.text();
        if (text.trim() !== '') {
          return text.trim();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${path}`);
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function pollUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  }

  it('reproduces the leak: signaling only the root pid leaves the detached grandchild alive', async () => {
    const marker = `/tmp/process-tree-test-repro-${process.pid}-${Date.now()}`;
    const root = spawn('sh', ['-c', `setsid sh -c 'echo $$ > ${marker}; sleep 30' & wait`], {
      stdio: 'ignore',
    });
    spawned.push(root);
    if (root.pid === undefined) {
      throw new Error('failed to spawn root test process');
    }

    const grandchildPidText = await waitForFile(marker);
    const grandchildPid = Number(grandchildPidText);
    expect(Number.isInteger(grandchildPid)).toBe(true);

    // Simulate the OLD `pty.kill()`-only behavior: signal only the root.
    process.kill(root.pid, 'SIGTERM');

    // Give the root a moment to exit; the grandchild (different pgid) must
    // remain unaffected by a signal sent only to the root.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(grandchildPid)).toBe(true);

    // Clean up the leaked grandchild explicitly (afterEach only tracks `root`).
    try {
      process.kill(grandchildPid, 'SIGKILL');
    } catch {
      // best-effort
    }
  }, 10000);

  it('fix polarity: listDescendantPids + signalPids reaches the detached grandchild', async () => {
    const marker = `/tmp/process-tree-test-fix-${process.pid}-${Date.now()}`;
    const root = spawn('sh', ['-c', `setsid sh -c 'echo $$ > ${marker}; sleep 30' & wait`], {
      stdio: 'ignore',
    });
    spawned.push(root);
    if (root.pid === undefined) {
      throw new Error('failed to spawn root test process');
    }

    const grandchildPidText = await waitForFile(marker);
    const grandchildPid = Number(grandchildPidText);
    expect(Number.isInteger(grandchildPid)).toBe(true);

    const descendants = await listDescendantPids(root.pid);
    expect(descendants).toContain(grandchildPid);

    signalPids(descendants, 'SIGTERM');
    signalPids([root.pid], 'SIGTERM');

    const exited = await pollUntil(() => !isAlive(grandchildPid), 3000);
    if (!exited) {
      // Escalate, mirroring the production SIGTERM -> SIGKILL sequence.
      signalPids(descendants, 'SIGKILL');
    }
    const finalExited = await pollUntil(() => !isAlive(grandchildPid), 2000);
    expect(finalExited).toBe(true);
  }, 10000);
});
