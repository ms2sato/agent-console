import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * CI wrapper for `check-restore-failure-declaration.ts` (Issue #1871). This
 * smoke is FREE AND DETERMINISTIC (no real `claude` CLI, no OS subprocess,
 * no billing -- see the smoke's own header), which is exactly what makes it
 * safe to run from `bun:test` under `test:scripts` rather than leaving it a
 * manual-only gate like its billable siblings. See
 * `.claude/rules/test-trigger.md`'s "Registering a smoke script" section and
 * this smoke's own "Additional Verification: Restore-Failure Declaration
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

interface SmokeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runSmoke(extraArgs: string[] = []): SmokeRunResult {
  const result = Bun.spawnSync(['bun', SMOKE_PATH, ...extraArgs], {
    cwd: REPO_ROOT,
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('check-restore-failure-declaration.ts CI wrapper (Issue #1871)', () => {
  it('default mode: exits 0 and reports checks passed', () => {
    const result = runSmoke();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/checks passed/);
  });

  it('-- --expect-no-declaration mode: exits 0 and reports checks passed', () => {
    const result = runSmoke(['--expect-no-declaration']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/checks passed/);
  });
});
