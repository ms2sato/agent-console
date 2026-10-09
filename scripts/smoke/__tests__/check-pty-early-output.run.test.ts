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
 *
 * Contention finding (Issue #1872): a sibling wrapper in this same PR
 * (`check-exit-127-diagnostic.run.test.ts`) flaked 1-in-5 on a loaded
 * shared host because its smoke's own wait bound lost a race under PTY
 * fork/exec scheduling delay. This smoke's `MARKER_WAIT_TIMEOUT_MS` /
 * `EXIT_WAIT_TIMEOUT_MS` were widened for the same reason (see the smoke's
 * own comment); this wrapper additionally surfaces the smoke's captured
 * stdout+stderr on any future failure so the actual cause is visible
 * without a local re-run.
 */
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_PATH = 'scripts/smoke/check-pty-early-output.ts';
const SPAWN_TIMEOUT_MS = 150_000;
const IT_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_TAIL_LINES = 40;

function tail(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

describe('check-pty-early-output.ts CI wrapper (Issue #1872)', () => {
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
