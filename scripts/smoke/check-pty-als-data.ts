#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the AsyncLocalStorage / Bun.spawn({ terminal })
 * data-delivery bug (Issue #1242).
 *
 * Root cause: Bun (verified on 1.3.5, macOS and Linux) never invokes the
 * `terminal.data` callback for a `Bun.spawn({ terminal: ... })` subprocess
 * whose spawn call happens while an AsyncLocalStorage context is active (a
 * non-empty AsyncContextFrame is current) -- zero bytes ever reach JS.
 * Non-terminal (pipe) spawns are unaffected, and `als.exit()` does NOT avoid
 * the bug; only spawning under the pristine (empty) top-level async context
 * works. The server's MCP tool handlers run inside
 * `mcpCallerStorage.run(caller, () => transport.handleRequest(c))` (see
 * `packages/server/src/mcp/mcp-server.ts`), so agent-worker PTYs spawned
 * during MCP `delegate_to_worktree`'s create path hit this directly: the
 * login-shell sentinel watchdog recorded `fireCount: 0` -- the native side
 * never called back into JS at all. The fix wraps the `Bun.spawn` call in
 * `bunTerminalProvider` with a callback obtained from
 * `AsyncLocalStorage.snapshot()`, captured at module load (before any
 * `AsyncLocalStorage.run()` scope exists).
 *
 * `packages/server/src/lib/__tests__/pty-provider.test.ts`'s
 * "async-context escape (Issue #1242)" describe block proves the CALL-SITE
 * SHAPE: that `Bun.spawn` is invoked outside the caller's ALS scope. That is
 * necessary but NOT sufficient: it cannot prove the native layer actually
 * delivers bytes on a real PTY when spawned this way (see
 * `.claude/rules/os-environment-coupling.md` Discipline 1 -- a unit test
 * asserts the shape of a call site, not what the OS/native layer does with
 * it). This script closes that gap: it imports the production
 * `bunTerminalProvider` directly (no hand copy), spawns a REAL PTY from
 * inside a real `AsyncLocalStorage.run()` scope (mirroring the MCP request
 * scope in production), and asserts the child's output actually arrives.
 *
 * This script is ALSO the minimal reproduction to report upstream to Bun if
 * this regresses: run it against an unfixed `bunTerminalProvider` (spawn
 * called directly, no snapshot wrapper) and it fails deterministically.
 *
 * This does NOT exercise `worker-manager.ts`'s sentinel watchdog or
 * chunk-boundary sentinel gate (covered by worker-manager's own unit
 * tests); it isolates the PTY provider layer only, same scoping as
 * `check-pty-early-output.ts` and `check-pty-fd-leak.ts`.
 *
 * Usage:
 *   bun scripts/smoke/check-pty-als-data.ts
 *
 * Exit codes:
 *   0  all cycles observed the complete marker while spawned inside an
 *      AsyncLocalStorage.run() scope
 *   1  one or more cycles never observed the marker (the async-context
 *      escape did not close the gap -- a regression of Issue #1242)
 *   2  bad usage / cannot run at all (e.g. this environment cannot spawn a
 *      basic PTY via bunTerminalProvider) -- distinct from 1 so operators
 *      can tell apart "the smoke ran and found a real problem" vs "the
 *      smoke could not run"
 *
 * Sync contract: NONE -- `bunTerminalProvider` is imported directly from
 * production source. A regression in the async-context escape (or its
 * removal) changes this smoke's outcome automatically.
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
 * for an unrelated reason and misreport an async-context regression (Issue
 * #1200 class of problem: verify the probe works before trusting what it
 * reports). Spawned OUTSIDE any AsyncLocalStorage scope on purpose -- this
 * check is only about basic PTY viability, not the bug under test.
 */
async function selfCheck(): Promise<void> {
  try {
    const pty = bunTerminalProvider.spawn('sh', ['-c', 'echo ok'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });
    const exited = new Promise<void>((resolve) => {
      pty.onExit(() => resolve());
    });
    pty.onData(() => {});
    await Promise.race([exited, sleep(EXIT_WAIT_TIMEOUT_MS)]);
  } catch (err) {
    console.error(
      'Self-check failed: could not spawn a basic PTY via bunTerminalProvider -- cannot run this smoke.',
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

await selfCheck();

console.log(
  `==> running ${CYCLE_COUNT} AsyncLocalStorage-scoped spawn cycles via bunTerminalProvider (Issue #1242)`,
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
