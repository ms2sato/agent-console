import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * CI wrapper for `check-pty-early-output.ts` (Issue #1872, widening the
 * #1871 pattern). This smoke is FREE AND DETERMINISTIC (no billed CLI, no
 * elevation, no OS subprocess side effects left behind -- see the smoke's
 * own header and its `test-trigger.md` "Additional Verification: PTY
 * Pre-Attach Output Buffer Smoke" section), which is exactly what makes it
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
 * Does not pin the smoke's own cycle count (`20/20`) -- that is the smoke's
 * business, not this wrapper's. Asserts only exit code 0 and the presence
 * of the "PASSED" summary line.
 *
 * Measured wall-clock on this host: ~21.2s, the most expensive of the four
 * siblings landed in this PR. `bun:test`'s per-test default timeout is 5s,
 * which this smoke's own runtime already exceeds -- an explicit `it`
 * timeout (180s) is mandatory here, not optional, or this wrapper fails on
 * the harness rather than the code. The spawn-level `timeout` is set
 * generously below that bound.
 *
 * Polarity (measured, not merely stated): with the smoke's own
 * `const ok = output.includes(marker);` (in `runCycle`) edited to
 * `output.includes(marker + '_POLARITY_BREAK')`, the test below fails --
 * all 20/20 cycles FAIL to observe the (now unmatchable) marker and the
 * script exits 1, not 0. Measured by running the edited smoke directly:
 * `FAILED: 20/20 cycle(s) lost the early marker`, exit code 1. Edit was
 * reverted immediately after measuring; this wrapper leaves the smoke's
 * fault injection untouched.
 */
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_PATH = 'scripts/smoke/check-pty-early-output.ts';
const SPAWN_TIMEOUT_MS = 150_000;
const IT_TIMEOUT_MS = 180_000;

describe('check-pty-early-output.ts CI wrapper (Issue #1872)', () => {
  it(
    'default mode: exits 0 and reports PASSED',
    () => {
      const result = Bun.spawnSync(['bun', SMOKE_PATH], {
        cwd: REPO_ROOT,
        timeout: SPAWN_TIMEOUT_MS,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toMatch(/PASSED/);
    },
    IT_TIMEOUT_MS,
  );
});
