import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * CI wrapper for `check-restore-failure-declaration.ts` (Issue #1871). This
 * smoke is FREE AND DETERMINISTIC (no real `claude` CLI, no OS subprocess,
 * no billing -- see the smoke's own header), which is exactly what makes it
 * safe to run from `bun:test` under `test:scripts` rather than leaving it a
 * manual-only gate like its billable siblings. See
 * `.claude/rules/test-trigger.md`'s "Registering a smoke script" section and
 * `smoke-verification-embedded.md`'s "Additional Verification: Restore-Failure Declaration
 * (R6) Smoke" section for the rule-text basis.
 *
 * SPAWNS, never imports -- per `import-safety.test.ts`'s own discipline,
 * importing a `scripts/smoke/*` file must never execute it, so this test
 * drives the script exactly the way an operator would: as its own process,
 * via `bun scripts/smoke/<file>`.
 *
 * Does not pin the smoke's own check counts (`9/9`, `4/4`) -- those are the
 * smoke's business, not this wrapper's. Asserts only exit code 0 and the
 * presence of the "checks passed" summary line both modes print.
 *
 * Polarity (measured, not merely stated): with
 * `getMcpBaseUrl: () => 'http://127.0.0.1:1/mcp'` (scripts/smoke/
 * check-restore-failure-declaration.ts) reverted to `() => ''`, both `it`s
 * below fail -- the smoke's activation throws `TypeError: "" cannot be
 * parsed as a URL` before either mode can run any of its checks, and the
 * script exits 2 (bad usage / could not run), not 0. Measured by running
 * this exact test file against the reverted source: both tests failed on
 * `expect(result.exitCode).toBe(0)` with `Received: 2`.
 */
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_PATH = 'scripts/smoke/check-restore-failure-declaration.ts';
const SPAWN_TIMEOUT_MS = 120_000;
// Per-test timeout: the spawn budget plus margin, so the spawn budget is the binding limit.
const IT_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 5_000;

interface SmokeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function runSmoke(extraArgs: string[] = []): SmokeRunResult {
  const startedAt = performance.now();
  const result = Bun.spawnSync(['bun', SMOKE_PATH, ...extraArgs], {
    cwd: REPO_ROOT,
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

/** The last `n` lines of a stream, so a failure message names the `==>` phase the smoke reached. */
function tail(text: string, n = 40): string {
  return text.split('\n').slice(-n).join('\n');
}

/**
 * Fails with the smoke's own captured output tail and the elapsed time when the run did not exit 0
 * (a non-zero exit, or a null exit from a timeout), so a recurrence of an unidentified stall shows
 * where it stalled instead of only `Expected: 0 / Received: null`. A no-op on the green path.
 */
function assertSmokeExitedZero(result: SmokeRunResult): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `smoke exited ${String(result.exitCode)} after ${result.elapsedMs} ms\n` +
      `--- stdout (last 40 lines) ---\n${tail(result.stdout)}\n` +
      `--- stderr (last 40 lines) ---\n${tail(result.stderr)}`,
  );
}

describe('check-restore-failure-declaration.ts CI wrapper (Issue #1871)', () => {
  // The spawn budget is 120 s; without an explicit per-test timeout the 5 s bun:test default
  // bound the run and false-failed on a loaded runner (main 9913dec9, 2026-10-13); measured idle
  // run 0.6-1.9 s.
  it(
    'default mode: exits 0 and reports checks passed',
    () => {
      const result = runSmoke();

      assertSmokeExitedZero(result);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/checks passed/);
    },
    IT_TIMEOUT_MS,
  );

  it(
    '-- --expect-no-declaration mode: exits 0 and reports checks passed',
    () => {
      const result = runSmoke(['--expect-no-declaration']);

      assertSmokeExitedZero(result);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/checks passed/);
    },
    IT_TIMEOUT_MS,
  );
});
