/**
 * Regression pin for the silent-skip shape a broken memfs `mock.module()`
 * factory produces: when a module whose import graph reaches an ESM
 * default import of `node:fs` (or a sibling Node built-in) is first
 * evaluated AFTER the mock is installed, the import throws
 * `SyntaxError: Missing 'default' export in module '...'`. `bun:test`
 * reports this as "Unhandled error between tests", which aborts the whole
 * file with 0 of its tests run -- and the run-level summary still prints
 * "N fail" rather than the count of tests that never ran, so a shallow
 * read of the summary looks like an ordinary single failing assertion
 * instead of an entire file being skipped.
 *
 * This pin spawns a real `bun test` subprocess over the exact control pair
 * (a memfs-using file, then the affected route test file, in one
 * invocation) and asserts the summary reports the SUM of both files' own
 * test counts with 0 fail and no unhandled-error line -- the class this
 * pin guards, not just today's specific file pair, catches a future mock
 * that drops `default` again or a new memfs specifier that needs it.
 *
 * Pre-fix measured output (2026-09-24, with the mock-fs-helper fix
 * reverted to `() => fs` / `() => fs.promises`):
 *   21 pass / 1 fail / 1 error, "Unhandled error between tests" present,
 *   0 of workers.test.ts's 69 tests run (Ran 22 tests across 2 files).
 * Post-fix: 90 pass / 0 fail, no unhandled-error line (Ran 90 tests across
 * 2 files) -- the sum of both files' own counts.
 *
 * Polarity of this pin itself, measured 2026-09-24 (same revert): the
 * `hasUnhandledError` assertion fails with `Expected: false / Received:
 * true` -- 0 pass / 1 fail. Restoring the fix: 1 pass / 0 fail.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__ -> packages/server
const SERVER_ROOT = join(__dirname, '..', '..');

const MEMFS_USING_FILE = 'src/lib/__tests__/worker-output-file-range.test.ts';
const TARGET_FILE = 'src/routes/__tests__/workers.test.ts';
const SPAWN_TIMEOUT_MS = 30_000;

interface BunTestSummary {
  passCount: number;
  failCount: number;
  hasUnhandledError: boolean;
  raw: string;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseBunTestSummary(stderr: string): BunTestSummary {
  const clean = stripAnsi(stderr);
  const passMatch = clean.match(/(\d+)\s+pass/);
  const failMatch = clean.match(/(\d+)\s+fail/);
  return {
    passCount: passMatch ? Number(passMatch[1]) : 0,
    failCount: failMatch ? Number(failMatch[1]) : 0,
    hasUnhandledError: clean.includes('Unhandled error between tests'),
    raw: clean,
  };
}

async function runBunTest(files: string[]): Promise<BunTestSummary> {
  const proc = Bun.spawn(['bun', 'test', ...files], {
    cwd: SERVER_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SPAWN_TIMEOUT_MS,
  });
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return parseBunTestSummary(stderr);
}

describe('memfs mock ordering across one bun test invocation', () => {
  it(
    "reports the sum of both files' own test counts, 0 fail, and no unhandled-error line when the memfs-using file runs first",
    async () => {
      // Baselines run alone, sequentially -- not in parallel with each
      // other or with the combined run -- to keep resource usage on a
      // shared host low and to avoid conflating this pin's own subprocess
      // ordering with the ordering shape it is pinning.
      const memfsAlone = await runBunTest([MEMFS_USING_FILE]);
      const targetAlone = await runBunTest([TARGET_FILE]);
      // Positive control: both files genuinely contain tests, so a sum of
      // zero can never satisfy the assertions below vacuously.
      expect(memfsAlone.passCount).toBeGreaterThan(0);
      expect(targetAlone.passCount).toBeGreaterThan(0);

      const combined = await runBunTest([MEMFS_USING_FILE, TARGET_FILE]);

      expect(combined.hasUnhandledError).toBe(false);
      expect(combined.failCount).toBe(0);
      expect(combined.passCount).toBe(memfsAlone.passCount + targetAlone.passCount);
    },
    SPAWN_TIMEOUT_MS * 3 + 5_000
  );
});
