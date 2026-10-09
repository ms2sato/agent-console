/**
 * Real-process regression test for Issue #1877: `WorkerManager.killWorker`'s
 * PTY-kill call must send SIGHUP, not the default SIGTERM, to the PTY root.
 *
 * The PTY root is, for both worker types, the interactive login shell built
 * by `sentinel-spawn-command.ts` (`exec $SHELL -l -c 'echo <sentinel>; exec
 * $SHELL'`). An interactive POSIX shell ignores SIGTERM by design; it does
 * exit on SIGHUP (the signal a controlling terminal's hangup naturally
 * sends). Measured by the Architect on this host (2026-10-09): spawning
 * `sh -c 'echo m; exec sh'` and killing it -- SIGTERM (default): not exited
 * after 1509ms, pid still alive; SIGHUP: exited in 20ms.
 *
 * This drives the REAL `WorkerManager.killWorker` against a REAL `sh`
 * process spawned via the real `bunTerminalProvider`. The mocked suite in
 * `worker-manager.test.ts` uses `MockPty`, which fires its exit callback for
 * any signal unless a test overrides `kill()` to simulate the SIGTERM-
 * ignoring behavior by hand -- there is no way to let an in-memory PTY
 * demonstrate the real OS fact on its own. This is therefore a real-fs test
 * (kernel-level PTY check, per `memfs-detection.ts`'s documented class) and
 * is listed in `packages/server/package.json`'s second `bun test`
 * invocation.
 *
 * On unmodified `main` (killWorker calling the bare `pty.kill()`, default
 * SIGTERM), this test fails: the real shell does not exit within the
 * 1000ms deadline below (it only exits ~5000ms later, once
 * `PTY_EXIT_TIMEOUT_MS` gives up and `detachPty` -> `dispose()` ->
 * `terminal.close()` sends the real hangup).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { bunTerminalProvider } from '../../lib/pty-provider.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SingleUserMode } from '../user-mode.js';
import { WorkerManager } from '../worker-manager.js';
import type { InternalTerminalWorker } from '../worker-types.js';
import type { AgentManager } from '../agent-manager.js';

const KILL_DEADLINE_MS = 1000;

describe('WorkerManager.killWorker real PTY root signal (#1877)', () => {
  const spawnedWorkers: InternalTerminalWorker[] = [];

  afterEach(() => {
    // Best-effort safety net: SIGKILL anything that is still alive (e.g. an
    // assertion threw before `killWorker` finished). `killWorker` itself
    // already disposes/nulls `worker.pty` on its own success/timeout paths,
    // so this is normally a no-op.
    for (const worker of spawnedWorkers.splice(0)) {
      worker.pty?.kill('SIGKILL');
      worker.pty?.dispose?.();
    }
  });

  it(
    'exits the real PTY root well within 1000ms (killWorker sends SIGHUP, not SIGTERM)',
    async () => {
      await assertRealFs('worker-manager-kill-signal-real-fs.test.ts');

      const userMode = new SingleUserMode(bunTerminalProvider, {
        id: 'test-user-id',
        username: 'testuser',
        homeDir: process.env.HOME ?? '/root',
      });
      // `agentManager` is only read by `initializeAgentWorker` -- never by
      // `killWorker` -- and the worker built below is constructed directly
      // (not via that method), so a cast stub is safe here and avoids
      // pulling in a real SQLite-backed `AgentManager` for a test that
      // never exercises it (pre-pr-completeness.md Q13: upstream of, and
      // outside, the chain under test).
      const workerManager = new WorkerManager(
        userMode,
        null as unknown as AgentManager,
        new WorkerOutputFileManager(),
      );

      const pty = bunTerminalProvider.spawn('sh', ['-c', 'exec sh'], {
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TERM: 'xterm-256color' },
      });

      const worker: InternalTerminalWorker = {
        id: 'terminal-1877',
        type: 'terminal',
        name: 'Test Terminal',
        createdAt: new Date().toISOString(),
        pty,
        outputBuffer: '',
        outputOffset: 0,
        epoch: Date.now(),
        connectionCallbacks: new Map(),
      };
      spawnedWorkers.push(worker);

      // Give the shell a moment to exec into its interactive tail before
      // the kill, matching killWorker's real-world timing (the PTY is
      // always well into its life before a kill is ever requested).
      await new Promise((resolve) => setTimeout(resolve, 200));

      const start = performance.now();
      await workerManager.killWorker(worker, 'test-session');
      const elapsed = performance.now() - start;

      expect(worker.pty).toBeNull();
      expect(elapsed).toBeLessThan(KILL_DEADLINE_MS);
    },
    8000,
  );
});
