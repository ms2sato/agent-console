#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the exit-127 diagnostic message (Issue #1294).
 *
 * ## Why this smoke exists instead of a UI-reachable repro
 *
 * Issue #1294's acceptance criteria originally called for reproducing the
 * bug via the UI: pick an agent whose `commandTemplate` names a missing
 * binary, create a worker, watch it fail. That recipe turned out to be
 * IMPOSSIBLE against the production spawn path. Both
 * `buildDirectSentinelShellCommand` and `buildElevatedSentinelCommand`
 * (`../../packages/server/src/services/sentinel-spawn-command.js`) end in a
 * bare `exec $SHELL` -- the agent's own command is not typed until AFTER
 * that interactive login shell is already alive and has echoed the
 * sentinel. A bad `commandTemplate` therefore produces a normal
 * "command not found" line printed BY the interactive shell (which does
 * not die from it) followed by that shell sitting there ready for more
 * input -- never an exit 127 on the PTY's child process itself. There is no
 * UI-reachable way to make the wrapper's OWN `exec $SHELL` fail.
 *
 * The architect-confirmed, production-representative trigger is instead:
 * point the SPAWNED PROCESS's `$SHELL` at a nonexistent binary. That makes
 * the wrapper's outer `exec $SHELL -l -c '...'` itself fail to exec, before
 * the sentinel is ever echoed -- reproducing the exact signature this Issue
 * was diagnosed from: exit 127, milliseconds after spawn, zero PTY bytes,
 * pre-sentinel. This is exactly the shape a misconfigured multi-user login
 * shell (the real-world trigger) produces, just forced deterministically.
 *
 * ## What this smoke exercises
 *
 *   - The REAL production chain end-to-end: `bunPtyProvider` (real PTY) ->
 *     `SingleUserMode.spawnPty` (real spawn-command construction) ->
 *     `WorkerManager.activateAgentWorkerPty` / `setupWorkerEventHandlers`'s
 *     `onExit` handler -> `appendSpawnFailureNotification` ->
 *     `WorkerOutputFileManager` (real fs, no memfs -- this runs as a
 *     standalone `bun` script, not under `bun:test`, so there is no memfs
 *     mock active).
 *   - The T2 property from `worker-manager.test.ts` (Issue #1294) against a
 *     REAL process instead of MockPty: zero WebSocket clients ever
 *     attached, the diagnostic message still reaches disk because the
 *     `onExit` handler force-flushes before returning.
 *   - `worker.pty` transitioning to `null` (proof `detachPty` ran) only
 *     AFTER the diagnostic append+flush completed, since the awaited
 *     `appendSpawnFailureNotification` call runs strictly before
 *     `detachPty` in the `onExit` handler.
 *
 * ## What this smoke does NOT exercise
 *
 *   - The elevated/multi-user spawn path specifically. The wrapper shape is
 *     identical between direct and elevated per `sentinel-spawn-command.ts`
 *     (both end in `exec $SHELL`), and the unit tests plus
 *     `check-login-shell-sentinel.ts --elevated` already cover elevation
 *     itself. This smoke isolates the WorkerManager exit-observer +
 *     output-capture chain, not privilege elevation.
 *   - The agent-console HTTP/WebSocket server. No server process runs here;
 *     `WorkerManager` is exercised directly, same as `worker-manager.test.ts`.
 *
 * Usage:
 *   bun scripts/smoke/check-exit-127-diagnostic.ts
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  the scenario ran but an assertion failed (the system is wrong)
 *   2  bad usage / cannot run at all (self-check failure, or an unexpected
 *      exception during setup). Distinct from 1 so operators can tell apart
 *      "the smoke ran and found a real problem" vs "the smoke could not run".
 *
 * Sync contract: NONE -- `bunPtyProvider`, `SingleUserMode`, `WorkerManager`,
 * and `WorkerOutputFileManager` are imported directly from production
 * source. A regression in the exit-127 diagnostic path changes this smoke's
 * outcome automatically.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';

import { bunPtyProvider } from '../../packages/server/src/lib/pty-provider.js';
import { SingleUserMode } from '../../packages/server/src/services/user-mode.js';
import { WorkerManager, type GlobalWorkerExitCallback } from '../../packages/server/src/services/worker-manager.js';
import { WorkerOutputFileManager } from '../../packages/server/src/lib/worker-output-file.js';
import { SessionDataPathResolver } from '../../packages/server/src/lib/session-data-path-resolver.js';
import { AgentManager, CLAUDE_CODE_AGENT_ID } from '../../packages/server/src/services/agent-manager.js';
import { SqliteAgentRepository } from '../../packages/server/src/repositories/sqlite-agent-repository.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../packages/server/src/database/connection.js';

process.chdir('/');

const EXIT_WAIT_TIMEOUT_MS = 5000;
const POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(POLL_MS);
  }
  return pred();
}

/**
 * Prove this environment can spawn and observe the exit of a basic PTY via
 * `bunPtyProvider` before trusting the real scenario below. If spawning
 * itself is broken, the scenario would fail for an unrelated reason and
 * misreport a real regression.
 */
async function selfCheck(): Promise<void> {
  try {
    const pty = bunPtyProvider.spawn('sh', ['-c', 'echo ok'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });
    const exited = new Promise<void>((resolve) => {
      pty.onExit(() => resolve());
    });
    pty.onData(() => {});
    const ok = await Promise.race([exited.then(() => true), sleep(EXIT_WAIT_TIMEOUT_MS).then(() => false)]);
    if (!ok) {
      throw new Error('basic PTY did not exit within timeout');
    }
  } catch (err) {
    console.error('Self-check failed: could not spawn/observe a basic PTY via bunPtyProvider -- cannot run this smoke.');
    console.error(err);
    process.exit(2);
  }
}

await selfCheck();

const smokeUsername = os.userInfo().username;
const smokeHomeDir = os.homedir();

let smokeDir: string | undefined;
let exitCode = 0;

try {
  smokeDir = await mkdtemp(path.join(tmpdir(), 'agent-console-smoke-1294-'));
  const resolver = new SessionDataPathResolver(smokeDir);

  // Real SQLite, in-memory -- mirrors worker-manager.test.ts's AgentManager
  // construction exactly, minus the memfs test-file wrapper.
  await initializeDatabase(':memory:');
  const db = getDatabase();
  const agentManager = await AgentManager.create(new SqliteAgentRepository(db));

  const userMode = new SingleUserMode(bunPtyProvider, {
    id: 'smoke-user-id',
    username: smokeUsername,
    homeDir: smokeHomeDir,
  });
  const outputFileManager = new WorkerOutputFileManager();
  const workerManager = new WorkerManager(userMode, agentManager, outputFileManager);

  const sessionId = `smoke-session-${crypto.randomUUID()}`;

  let observedExitCode: number | undefined;
  let observedExitSessionId: string | undefined;
  let observedExitWorkerId: string | undefined;
  const onExit: GlobalWorkerExitCallback = (sid, wid, code) => {
    observedExitSessionId = sid;
    observedExitWorkerId = wid;
    observedExitCode = code;
  };
  workerManager.setGlobalWorkerExitCallback(onExit);

  const worker = workerManager.initializeAgentWorker({
    id: `smoke-worker-${crypto.randomUUID()}`,
    name: 'Smoke Agent',
    createdAt: new Date().toISOString(),
    agentId: CLAUDE_CODE_AGENT_ID,
  });

  console.log('==> activating agent worker PTY with SHELL pointed at a nonexistent binary');
  // Deliberately: no attachCallbacks() call anywhere in this scenario --
  // zero WebSocket clients ever attached, mirroring T2's delegate-path
  // shape but against a real process.
  await workerManager.activateAgentWorkerPty(worker, {
    sessionId,
    locationPath: '/',
    // SHELL flows through additionalEnvVars in spawnDirectPty, spread AFTER
    // baseEnv and BEFORE the AGENT_CONSOLE_* security-pinned vars, so it
    // overrides the inherited $SHELL cleanly. Verified against
    // env-filter.ts: filterRepositoryEnvVars (which strips SHELL as a
    // PROTECTED_ENV_VAR) is only invoked by session-manager.ts when parsing
    // repository config -- WorkerManager.activateAgentWorkerPty takes
    // repositoryEnvVars -> additionalEnvVars UNFILTERED, so calling it
    // directly (as this smoke does) is not subject to that filter.
    repositoryEnvVars: { SHELL: '/nonexistent-xyz-127-smoke' },
    username: smokeUsername,
    resolver,
    agentId: CLAUDE_CODE_AGENT_ID,
    startupIntent: 'fresh',
    revived: false,
  });

  console.log('==> waiting for the real process to exit 127');
  const ptyDetached = await waitFor(() => worker.pty === null, EXIT_WAIT_TIMEOUT_MS);

  // ---------- assertions ----------
  const failures: string[] = [];
  let passes = 0;
  const expect = (cond: boolean, label: string, detail?: string) => {
    if (cond) {
      console.log(`  OK    ${label}`);
      passes++;
    } else {
      console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
      failures.push(label);
    }
  };

  console.log('==> exit-observer chain');
  expect(
    ptyDetached,
    'worker.pty became null within timeout (detachPty ran; onExit fired and completed)',
    `worker.pty=${JSON.stringify(worker.pty)}`,
  );
  expect(
    observedExitCode === 127,
    'the real spawned process exited with code 127',
    `observed exitCode=${String(observedExitCode)}`,
  );
  expect(observedExitSessionId === sessionId, 'exit callback reported the expected sessionId');
  expect(observedExitWorkerId === worker.id, 'exit callback reported the expected workerId');

  console.log('==> output file on disk (real fs, zero clients ever attached)');
  const outputFilePath = resolver.getOutputFilePath(sessionId, worker.id);
  let onDisk = '';
  try {
    onDisk = await fs.readFile(outputFilePath, 'utf-8');
  } catch (err) {
    console.error(`  could not read output file at ${outputFilePath}: ${String(err)}`);
  }
  expect(onDisk.includes('[internal:agent-spawn-failed]'), 'output file contains the diagnostic tag');
  expect(onDisk.includes('exitCode=127'), 'output file contains exitCode=127');
  expect(onDisk.includes(`username=${smokeUsername}`), `output file contains username=${smokeUsername}`);

  console.log('==> readHistoryWithOffset (manager read API)');
  const history = await outputFileManager.readHistoryWithOffset(sessionId, worker.id, resolver);
  expect(
    history.data.includes('[internal:agent-spawn-failed]'),
    'readHistoryWithOffset also returns the diagnostic message',
  );

  console.log();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    exitCode = 1;
  } else {
    console.log(`PASSED: ${passes} assertion(s) passed`);
    exitCode = 0;
  }

  await closeDatabase();
} catch (err) {
  console.error('Unexpected exception while running the exit-127 diagnostic smoke.');
  console.error(err);
  exitCode = 2;
} finally {
  if (smokeDir) {
    try {
      await rm(smokeDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; do not let it change the exit code
    }
  }
}

process.exit(exitCode);
