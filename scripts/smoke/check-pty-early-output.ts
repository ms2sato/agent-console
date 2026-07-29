#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the PTY pre-attach data buffer (Issue #1242).
 *
 * `bunTerminalProvider` (the default `PTY_PROVIDER`) wraps
 * `Bun.spawn({ terminal: ... })`. Two silent byte-loss windows existed in
 * that wrapper before the pre-attach buffer fix:
 *   1. Between `Bun.spawn()` returning and the `BunTerminalPtyAdapter`
 *      being constructed (native `data` callback fires with no adapter).
 *   2. Between adapter construction and the first `onData()` attach
 *      (`_emitData` fires with no listener).
 *
 * `packages/server/src/lib/__tests__/pty-provider.test.ts` proves the
 * buffer/flush LOGIC via synthetic `data` callback invocations against a
 * mocked `Bun.spawn`. That is necessary but NOT sufficient: it proves the
 * buffer works when fed bytes, not that bytes from a REAL `Bun.Terminal`
 * actually reach the buffer through Bun's native path in the first place
 * (see `.claude/rules/os-environment-coupling.md` Discipline 1 -- a unit
 * test asserts the shape of a call site, not what the OS/native layer does
 * with it). This script closes that gap: it imports the production
 * `bunTerminalProvider` directly (no hand copy) and spawns a REAL PTY whose
 * child emits output immediately, deliberately delaying the `onData`
 * attach past at least one event-loop turn -- the exact race the buffer
 * exists to close -- then asserts the early output is not lost.
 *
 * This does NOT exercise `worker-manager.ts`'s sentinel watchdog or
 * chunk-boundary sentinel gate (covered by worker-manager's own unit
 * tests); it isolates the PTY provider layer only, same scoping as
 * `check-pty-fd-leak.ts`.
 *
 * Usage:
 *   bun scripts/smoke/check-pty-early-output.ts
 *
 * Exit codes:
 *   0  all cycles observed the complete early marker
 *   1  one or more cycles lost bytes (the buffer did not close the race)
 *   2  bad usage / cannot run at all (e.g. this environment cannot spawn a
 *      basic PTY via bunTerminalProvider) -- distinct from 1 so operators
 *      can tell apart "the smoke ran and found a real problem" vs "the
 *      smoke could not run"
 *
 * Sync contract: NONE -- `bunTerminalProvider` is imported directly from
 * production source. A regression in the pre-attach buffer (or its
 * removal) changes this smoke's outcome automatically.
 */

import { bunTerminalProvider, type PtyInstance } from '../../packages/server/src/lib/pty-provider.js';

const CYCLE_COUNT = 20;
// Deliberately past at least one event-loop turn (a plain microtask/`await
// Promise.resolve()` would not reliably span a real macrotask boundary on
// every platform) -- long enough that the child's `echo` has certainly
// already run and handed its bytes to the native layer before any JS
// listener exists.
const LATE_ATTACH_DELAY_MS = 50;
const MARKER_WAIT_TIMEOUT_MS = 3000;
const EXIT_WAIT_TIMEOUT_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prove this environment can spawn a basic PTY via bunTerminalProvider
 * before trusting the race-detection cycles below. If spawning itself is
 * broken (no `sh`, Bun.Terminal unavailable, etc.), the cycles would fail
 * for an unrelated reason and misreport a buffer regression (Issue #1200
 * class of problem: verify the probe works before trusting what it reports).
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
  const marker = `SMOKE_EARLY_OUTPUT_${index}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  // The child emits the marker IMMEDIATELY, then execs into an idle shell
  // so the process stays alive until we kill it below -- mirrors the shape
  // the production login-shell sentinel protocol depends on (output before
  // any listener is attached, then a live interactive shell).
  const pty: PtyInstance = bunTerminalProvider.spawn('sh', ['-c', `echo ${marker}; exec sh`], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });

  // Deliberately delay the onData attach past at least one event-loop turn
  // -- this is the exact pre-attach race the buffer exists to close.
  await sleep(LATE_ATTACH_DELAY_MS);

  let output = '';
  const exited = new Promise<void>((resolve) => {
    pty.onExit(() => resolve());
  });
  pty.onData((chunk) => {
    output += chunk;
  });

  const start = Date.now();
  while (!output.includes(marker) && Date.now() - start < MARKER_WAIT_TIMEOUT_MS) {
    await sleep(20);
  }

  const ok = output.includes(marker);
  const diagnostics = pty.getDataDiagnostics?.();
  const detail = ok
    ? ''
    : `marker not observed after a ${LATE_ATTACH_DELAY_MS}ms late onData attach; ` +
      `diagnostics=${JSON.stringify(diagnostics)}; captured output: ${JSON.stringify(output.slice(0, 300))}`;

  try {
    pty.kill();
  } catch {
    // best-effort; the child may already be gone
  }
  await Promise.race([exited, sleep(EXIT_WAIT_TIMEOUT_MS)]);

  return { ok, detail };
}

await selfCheck();

console.log(
  `==> running ${CYCLE_COUNT} early-output cycles via bunTerminalProvider (Issue #1242), ` +
    `each with a deliberately-late (${LATE_ATTACH_DELAY_MS}ms) onData attach`,
);

const failures: string[] = [];
let passes = 0;
for (let i = 0; i < CYCLE_COUNT; i++) {
  const result = await runCycle(i);
  if (result.ok) {
    console.log(`  OK    cycle ${i}: early marker observed complete after late attach`);
    passes++;
  } else {
    console.error(`  FAIL  cycle ${i}: ${result.detail}`);
    failures.push(`cycle ${i}`);
  }
}

console.log();
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length}/${CYCLE_COUNT} cycle(s) lost the early marker -- ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`PASSED: ${passes}/${CYCLE_COUNT} cycles observed the complete early marker after a deliberately-late onData attach`);
process.exit(0);
