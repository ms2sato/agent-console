import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * CI wrapper for `check-exit-127-diagnostic.ts` (Issue #1872, widening the
 * #1871 pattern). This smoke is FREE AND DETERMINISTIC (no billed CLI, no
 * elevation, no OS subprocess side effects left behind -- see the smoke's
 * own header and its `test-trigger.md` "Additional Verification: Exit-127
 * Spawn-Failure Diagnostic Smoke" section), which is exactly what makes it
 * safe to run from `bun:test` under `test:scripts` rather than leaving it a
 * manual-only gate. See `.claude/rules/test-trigger.md`'s "Registering a
 * smoke script" section and this smoke's own section for the rule-text
 * basis.
 *
 * SPAWNS, never imports -- per `import-safety.test.ts`'s own discipline,
 * importing a `scripts/smoke/*` file must never execute it, so this test
 * drives the script exactly the way an operator would: as its own process,
 * via `bun scripts/smoke/<file>`.
 *
 * Does not pin the smoke's own assertion count (`8`) -- that is the smoke's
 * business, not this wrapper's. Asserts only exit code 0 and the presence
 * of the "PASSED" summary line.
 *
 * Measured wall-clock on this host: ~0.5s (well under the 5s bun:test
 * per-test default, but an explicit `it` timeout is still passed per the
 * Architect's AC, since the 11s/21s siblings in this same PR need it and
 * consistency aids future copy/paste).
 *
 * Polarity (measured, not merely stated): with the smoke's own
 * `repositoryEnvVars: { SHELL: '/nonexistent-xyz-127-smoke' }` edited to
 * `{ SHELL: '/bin/sh' }` (an existing binary, so the spawned process never
 * exits 127), the test below fails -- all 8 of the smoke's own assertions
 * FAIL (exit observer never sees code 127, no diagnostic reaches disk) and
 * the script exits 1, not 0. Measured by running the edited smoke directly:
 * `FAILED: 8 assertion(s) failed`, exit code 1. Edit was reverted
 * immediately after measuring; this wrapper leaves the smoke's fault
 * injection untouched.
 *
 * Contention finding (Issue #1872): a 1-in-5 flaky run on a loaded shared
 * host returned exitCode 2 from the smoke's own `selfCheck()` -- its
 * `EXIT_WAIT_TIMEOUT_MS` race (5000ms at the time) lost under PTY
 * fork/exec scheduling delay, not a logic bug. Fixed by widening that
 * bound in the smoke itself (see its own header/comment); this wrapper
 * additionally surfaces the smoke's captured stdout+stderr on any future
 * failure so the actual cause (e.g. "did not exit within timeout" vs a
 * real regression) is visible without a local re-run.
 */
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_PATH = 'scripts/smoke/check-exit-127-diagnostic.ts';
const SPAWN_TIMEOUT_MS = 150_000;
const IT_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_TAIL_LINES = 40;

function tail(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

describe('check-exit-127-diagnostic.ts CI wrapper (Issue #1872)', () => {
  it(
    'default mode: exits 0 and reports PASSED',
    () => {
      const result = Bun.spawnSync(['bun', SMOKE_PATH], {
        cwd: REPO_ROOT,
        timeout: SPAWN_TIMEOUT_MS,
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      const diagnostic =
        `smoke stdout (last ${DIAGNOSTIC_TAIL_LINES} lines):\n${tail(stdout, DIAGNOSTIC_TAIL_LINES)}\n\n` +
        `smoke stderr (last ${DIAGNOSTIC_TAIL_LINES} lines):\n${tail(stderr, DIAGNOSTIC_TAIL_LINES)}`;

      expect(result.exitCode, diagnostic).toBe(0);
      expect(stdout, diagnostic).toMatch(/PASSED/);
    },
    IT_TIMEOUT_MS,
  );
});
