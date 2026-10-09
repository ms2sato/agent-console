import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * CI wrapper for `check-stdin-sink-leak.ts` (Issue #1872, widening the
 * #1871 pattern). This smoke is FREE AND DETERMINISTIC (no billed CLI, no
 * elevation, no OS subprocess side effects left behind -- see the smoke's
 * own header and its `test-trigger.md` "Additional Verification:
 * Stdin-Sink FD Leak Smoke" section), which is exactly what makes it safe
 * to run from `bun:test` under `test:scripts` rather than leaving it a
 * manual-only gate. See `.claude/rules/test-trigger.md`'s "Registering a
 * smoke script" section and this smoke's own section for the rule-text
 * basis.
 *
 * SPAWNS, never imports -- per `import-safety.test.ts`'s own discipline,
 * importing a `scripts/smoke/*` file must never execute it, so this test
 * drives the script exactly the way an operator would: as its own process,
 * via `bun scripts/smoke/<file>`.
 *
 * Does not pin the smoke's own fd counts -- that is the smoke's business,
 * not this wrapper's. Asserts only exit code 0 and the presence of the
 * "PASSED" summary line.
 *
 * Linux-only, by the smoke's own design (it reads `/proc/<pid>/fd`,
 * exiting 2 on any other platform -- see the smoke's own header "Exit
 * codes" section). `it.skipIf` keeps a macOS `bun run test` passing
 * instead of reporting a spurious failure for an environment the smoke was
 * never meant to run on.
 *
 * Measured wall-clock on this host: ~0.7s.
 *
 * Polarity (measured, not merely stated): with the production
 * `endStdinSafely(stored.stdin);` call inside `InteractiveProcessManager.
 * killProcess` (`packages/server/src/services/interactive-process-
 * manager.ts`) commented out, the test below fails -- the smoke's single
 * assertion FAILs (observed baseline=3, after=147, expectedMax=113: a real
 * per-cycle stdin fd leak) and the script exits 1, not 0. Measured by
 * running the edited production file directly against the unmodified
 * smoke: `FAILED: 1 assertion(s) failed`, exit code 1. Edit was reverted
 * immediately after measuring; this wrapper leaves both the smoke and
 * production code untouched.
 */
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_PATH = 'scripts/smoke/check-stdin-sink-leak.ts';
const SPAWN_TIMEOUT_MS = 150_000;
const IT_TIMEOUT_MS = 180_000;

describe('check-stdin-sink-leak.ts CI wrapper (Issue #1872)', () => {
  it.skipIf(process.platform !== 'linux')(
    'default mode: exits 0 and reports PASSED (Linux-only -- the smoke reads /proc/<pid>/fd)',
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
