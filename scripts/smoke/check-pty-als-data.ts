#!/usr/bin/env bun
/**
 * Regression smoke for AsyncLocalStorage / Bun.spawn({ terminal }) data
 * delivery.
 *
 * On Bun 1.3.5-1.3.13, the `terminal.data` callback of a
 * `Bun.spawn({ terminal: ... })` subprocess NEVER fires when the spawn call
 * happens while an AsyncLocalStorage context is active (a non-empty
 * AsyncContextFrame is current) -- zero bytes ever reach JS. Non-terminal
 * (pipe) spawns are unaffected, and `als.exit()` does NOT avoid the bug.
 * The server's MCP tool handlers run inside
 * `mcpCallerStorage.run(caller, () => transport.handleRequest(c))` (see
 * `packages/server/src/mcp/mcp-server.ts`), so agent-worker PTYs spawned
 * during MCP `delegate_to_worktree`'s create path hit this directly: the
 * login-shell sentinel watchdog recorded `fireCount: 0` -- the native side
 * never called back into JS at all -- while the same worker restarted via
 * the plain REST route (no AsyncLocalStorage scope) worked every time.
 *
 * The bug is fixed upstream in Bun 1.3.14, and the repo pins its floor
 * there (`MIN_BUN_VERSION` in scripts/check-bun-version.mjs). This smoke is
 * the gate that keeps the floor honest: it imports the production
 * `bunTerminalProvider` directly (no hand copy), spawns a REAL PTY from
 * inside a real `AsyncLocalStorage.run()` scope (mirroring the MCP request
 * scope in production), and asserts the child's output actually arrives.
 * It fails deterministically on any Bun where the bug exists (10/10 cycles,
 * fireCount 0 in the diagnostics), so it catches both a future Bun
 * regression of terminal+ALS delivery and any accidental downgrade of the
 * runtime below the floor. It is also the self-contained reproduction to
 * report upstream to Bun if the behavior ever regresses.
 *
 * This does NOT exercise `worker-manager.ts`'s sentinel watchdog or
 * chunk-boundary sentinel gate (covered by worker-manager's own unit
 * tests); it isolates the PTY provider layer only, same scoping as
 * `check-pty-early-output.ts` and `check-pty-fd-leak.ts`.
 *
 * Usage:
 *   bun scripts/smoke/check-pty-als-data.ts
 *
 * When to run: before (and after, on the upgraded host) ANY Bun runtime
 * upgrade or floor change. The failure mode this guards is silent in
 * production -- a delegated agent worker simply never starts -- so this
 * 15-second check is the designated canary for it.
 *
 * Exit codes:
 *   0  all cycles observed the complete marker while spawned inside an
 *      AsyncLocalStorage.run() scope
 *   1  one or more cycles never observed the marker (the terminal+ALS
 *      data-delivery bug is present in this runtime)
 *   2  bad usage / cannot run at all (e.g. this environment cannot spawn a
 *      basic PTY via bunTerminalProvider) -- distinct from 1 so operators
 *      can tell apart "the smoke ran and found a real problem" vs "the
 *      smoke could not run"
 *
 * Sync contract: NONE -- `bunTerminalProvider` is imported directly from
 * production source.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { bunTerminalProvider, type PtyInstance } from '../../packages/server/src/lib/pty-provider.js';

const CYCLE_COUNT = 10;
const MARKER_WAIT_TIMEOUT_MS = 3000;
const EXIT_WAIT_TIMEOUT_MS = 1000;

// Mirrors the ALS instance shape used by the server's MCP request scope
// (`mcpCallerStorage` in packages/server/src/mcp/mcp-server.ts) -- an
// AsyncLocalStorage carrying some request-scoped value across the
// spawn call.
const requestScope = new AsyncLocalStorage<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prove this environment can spawn a basic PTY via bunTerminalProvider
 * before trusting the async-context cycles below. If spawning itself is
 * broken (no `sh`, Bun.Terminal unavailable, etc.), the cycles would fail
 * for an unrelated reason and misreport an async-context regression (verify the probe works before trusting what it
 * reports). Spawned OUTSIDE any AsyncLocalStorage scope on purpose -- this
 * check is only about basic PTY viability, not the bug under test.
 */
async function selfCheck(): Promise<void> {
  // The probe runs OUTSIDE any AsyncLocalStorage scope on purpose: data
  // delivery here works even on runtimes where the ALS-scoped bug exists,
  // so requiring the marker below does not weaken the cycles' polarity.
  const probeMarker = 'SMOKE_ALS_SELFCHECK_OK';
  try {
    const pty = bunTerminalProvider.spawn('sh', ['-c', `echo ${probeMarker}`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });
    const exited = new Promise<void>((resolve) => {
      pty.onExit(() => resolve());
    });
    let output = '';
    pty.onData((chunk) => {
      output += chunk;
    });
    const start = Date.now();
    while (!output.includes(probeMarker) && Date.now() - start < MARKER_WAIT_TIMEOUT_MS) {
      await sleep(20);
    }
    if (!output.includes(probeMarker)) {
      throw new Error(
        `basic PTY output never arrived outside AsyncLocalStorage (captured: ${JSON.stringify(output.slice(0, 200))})`,
      );
    }
    await Promise.race([exited, sleep(EXIT_WAIT_TIMEOUT_MS)]);
  } catch (err) {
    console.error(
      'Self-check failed: could not spawn a basic working PTY via bunTerminalProvider -- cannot run this smoke.',
    );
    console.error(err);
    process.exit(2);
  }
}

async function runCycle(index: number): Promise<{ ok: boolean; detail: string }> {
  const marker = `SMOKE_ALS_DATA_${index}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  // Spawn from INSIDE a real AsyncLocalStorage.run() scope -- this is the
  // exact shape production hits: MCP tool handlers run inside
  // `mcpCallerStorage.run(caller, () => ...)`, and delegate_to_worktree's
  // create path spawns the agent-worker PTY from within that scope.
  let pty: PtyInstance | undefined;
  requestScope.run('mcp-request-scope', () => {
    pty = bunTerminalProvider.spawn('sh', ['-c', `echo ${marker}; exec sh`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });
  });
  if (!pty) {
    return { ok: false, detail: 'spawn() did not return a PtyInstance' };
  }
  const ptyInstance = pty;

  let output = '';
  const exited = new Promise<void>((resolve) => {
    ptyInstance.onExit(() => resolve());
  });
  ptyInstance.onData((chunk) => {
    output += chunk;
  });

  const start = Date.now();
  while (!output.includes(marker) && Date.now() - start < MARKER_WAIT_TIMEOUT_MS) {
    await sleep(20);
  }

  const ok = output.includes(marker);
  const diagnostics = ptyInstance.getDataDiagnostics?.();
  const detail = ok
    ? ''
    : `marker not observed after spawning inside AsyncLocalStorage.run(); ` +
      `diagnostics=${JSON.stringify(diagnostics)}; captured output: ${JSON.stringify(output.slice(0, 300))}`;

  try {
    ptyInstance.kill();
  } catch {
    // best-effort; the child may already be gone
  }
  await Promise.race([exited, sleep(EXIT_WAIT_TIMEOUT_MS)]);

  return { ok, detail };
}

// Extracted into main() (Issue #1479), order-preserving verbatim move: this
// entire body was top-level, executing as a side effect of merely importing
// this file. Guarded below so only running it as the entry point does.
async function main(): Promise<void> {
  await selfCheck();

  console.log(
    `==> running ${CYCLE_COUNT} AsyncLocalStorage-scoped spawn cycles via bunTerminalProvider`,
  );

  const failures: string[] = [];
  let passes = 0;
  for (let i = 0; i < CYCLE_COUNT; i++) {
    const result = await runCycle(i);
    if (result.ok) {
      console.log(`  OK    cycle ${i}: marker observed after spawning inside AsyncLocalStorage.run()`);
      passes++;
    } else {
      console.error(`  FAIL  cycle ${i}: ${result.detail}`);
      failures.push(`cycle ${i}`);
    }
  }

  console.log();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length}/${CYCLE_COUNT} cycle(s) never observed the marker -- ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes}/${CYCLE_COUNT} cycles observed the complete marker when spawned inside AsyncLocalStorage.run()`);
  process.exit(0);
}

if (import.meta.main) {
  main();
}
