import { describe, it, expect } from 'bun:test';
// Importing this module installs the memfs `fs` / `node:fs` / `fs/promises` /
// `node:fs/promises` mocks (mock.module is process-global and permanent for
// the life of this test process).
//
// Polarity measured 2026-09-24: with the helper's mock factories reverted to
// `() => fs` / `() => fs.promises` (dropping the `default` property), both
// cases below throw `SyntaxError: Missing 'default' export in module
// 'node:fs'` -- 0 pass / 2 fail. With the fix in place, both pass.
import '../mock-fs-helper.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

describe('mock-fs-helper module mock shape', () => {
  it('lets a module whose import graph reaches a default-importer of node:fs resolve', async () => {
    // routes/system.ts -> `open` -> is-wsl / is-docker / is-inside-container,
    // which do `import fs from 'node:fs'` (an ESM default import). This is
    // the exact module the bisection in the linked defect report isolated:
    // with the mocks installed and no `default` on the mocked module, this
    // import throws `SyntaxError: Missing 'default' export in module
    // 'node:fs'` instead of resolving.
    const mod = await import('../../../routes/system.js');

    expect(mod).toBeDefined();
  });

  it('pins the default-import shape independently of which dependency uses it today', async () => {
    // A dedicated fixture (imported nowhere else) isolates the shape from
    // any particular dependency's import graph: a plain ESM default import
    // of node:fs must resolve to an object with the real fs methods,
    // regardless of which library happens to do this today.
    const mod = await import('./fixtures/default-fs-import.js');

    expect(mod.ok).toBe(true);
  });
});

// src/__tests__/utils/__tests__ -> packages/server
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, '..', '..', '..', '..');
const TARGET_FILE = 'src/routes/__tests__/workers.test.ts';
const MOCK_HELPER_PRELOAD = './src/__tests__/utils/mock-fs-helper.ts';
const SPAWN_TIMEOUT_MS = 30_000;

interface BunTestSummary {
  passCount: number;
  failCount: number;
  hasUnhandledError: boolean;
  exitCode: number;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseBunTestSummary(stderr: string, exitCode: number): BunTestSummary {
  const clean = stripAnsi(stderr);
  const passMatch = clean.match(/(\d+)\s+pass/);
  const failMatch = clean.match(/(\d+)\s+fail/);
  return {
    passCount: passMatch ? Number(passMatch[1]) : 0,
    failCount: failMatch ? Number(failMatch[1]) : 0,
    hasUnhandledError: clean.includes('Unhandled error between tests'),
    exitCode,
  };
}

async function runBunTest(args: string[]): Promise<BunTestSummary> {
  const proc = Bun.spawn(['bun', 'test', ...args], {
    cwd: SERVER_ROOT,
    // Nothing in this file asserts on stdout content -- only stderr carries
    // bun:test's reporter output (the pass/fail summary and the
    // "Unhandled error between tests" line). A piped stdout that nobody
    // reads can fill its OS pipe buffer and block the child indefinitely
    // if the target file writes enough of it; 'ignore' has no such buffer.
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: SPAWN_TIMEOUT_MS,
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return parseBunTestSummary(stderr, exitCode);
}

/**
 * Regression pin for the silent-skip shape a broken memfs `mock.module()`
 * factory produces: when a module whose import graph reaches an ESM
 * default import of `node:fs` (or a sibling Node built-in) is first
 * evaluated AFTER the mock is installed, the import throws
 * `SyntaxError: Missing 'default' export in module '...'`. `bun:test`
 * reports this as "Unhandled error between tests", which aborts the whole
 * file with 0 of its tests run.
 *
 * `--preload` is used deliberately instead of listing a second
 * memfs-using file ahead of the target on the command line: bun treats
 * positional file arguments as test FILTERS, not an execution-order
 * guarantee (see `.claude/rules/testing.md`'s "directory readdir order,
 * not CLI-arg order" note), so nothing about argument order can be relied
 * on to install the mock first. `--preload <file>` runs that file's
 * top-level side effects (here, the four `mock.module()` calls) before
 * ANY test file loads, deterministically reproducing the exact "mock
 * already active when this file's own imports run" condition regardless
 * of which order bun would otherwise process the arguments in.
 * `packages/integration` already uses this flag for the same reason
 * (`--preload ./src/setup.ts`).
 *
 * History: an earlier version of this pin spawned
 * `bun test <a memfs-using lib test file> src/routes/__tests__/workers.test.ts`
 * as a two-file positional pair, relying on that ordering. Pre-fix
 * measured output for THAT pair (2026-09-24, mock-fs-helper fix reverted):
 * 21 pass / 1 fail / 1 error, "Unhandled error between tests" present, 0
 * of workers.test.ts's 69 tests run (Ran 22 tests across 2 files).
 * CodeRabbit correctly flagged that this relied on an ordering bun does
 * not guarantee; superseded by the deterministic `--preload` form below.
 *
 * Polarity of the current form, measured 2026-09-24 (mock-fs-helper fix
 * reverted to `() => fs` / `() => fs.promises`): the whole file reports 0
 * pass / 3 fail (pin A's 2 cases plus this one). Inside this test, the
 * alone-control's assertions all pass first (exitCode 0, no unhandled
 * error, 0 fail, N > 0 pass); the FIRST assertion to actually fail is
 * `preloaded.exitCode` (`Expected: 0 / Received: 1` -- bun test exits 1 on
 * the unhandled error), before the `hasUnhandledError` check below it ever
 * runs. With the fix restored: 3 pass / 0 fail for the whole file.
 */
describe('memfs mock ordering: deterministic install via --preload', () => {
  it(
    'preloading mock-fs-helper reports the same pass count as running the target file alone, 0 fail, and no unhandled-error line',
    async () => {
      const alone = await runBunTest([TARGET_FILE]);
      // Positive control: the target file genuinely contains tests, and
      // ran to completion. `exitCode` is a second instrument alongside the
      // parsed summary -- a reformatted or empty reporter line would parse
      // to 0 pass / 0 fail, which `passCount > 0` alone catches, but the
      // exit code is what keeps a corrupted-but-nonzero parse from passing
      // vacuously. The equality assertion below (preloaded.passCount ===
      // alone.passCount) is what actually guards against "only one test
      // ran": `alone` is the full file by construction, so any harness
      // regression that under-runs the preloaded invocation breaks the
      // equality -- a hardcoded exact count would instead couple this pin
      // to every future edit of the target file for no added protection.
      expect(alone.exitCode).toBe(0);
      expect(alone.hasUnhandledError).toBe(false);
      expect(alone.failCount).toBe(0);
      expect(alone.passCount).toBeGreaterThan(0);

      const preloaded = await runBunTest(['--preload', MOCK_HELPER_PRELOAD, TARGET_FILE]);

      expect(preloaded.exitCode).toBe(0);
      expect(preloaded.hasUnhandledError).toBe(false);
      expect(preloaded.failCount).toBe(0);
      expect(preloaded.passCount).toBe(alone.passCount);
    },
    SPAWN_TIMEOUT_MS * 2 + 5_000
  );
});
