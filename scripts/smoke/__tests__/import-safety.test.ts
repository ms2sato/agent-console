import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import * as path from 'node:path';

/**
 * Regression pin for Issue #1479: importing a `scripts/smoke/*` file must
 * never execute it. Every script there previously either called an
 * unguarded `main()` at the top level, or (eight of them) had no `main()`
 * boundary at all -- raw top-level imperative code, `process.exit` included.
 * Importing any of them fired a billed run, mutated the importer's
 * environment, or killed the importer outright when the imported script's
 * own `process.exit` ran inside the SAME process.
 *
 * Glob-driven (not a hardcoded list): a future 19th (24th, ...) script is
 * covered automatically, with no separate registration step, per
 * `test-trigger.md`'s "Registering a smoke script" section.
 *
 * Subprocess-isolated (mandatory, not a style choice): importing a
 * regressed script IN-PROCESS would `process.exit` this very test runner,
 * or leak an `AUTH_MODE`/`chdir` mutation into every test that runs after
 * it in the same process. Each import happens in its own `bun -e` child, so
 * a regression is observed as that one subprocess's wrong exit code /
 * stdout / timeout, never as collateral damage to this test file or its
 * neighbors.
 *
 * Living under `scripts/`, this file is picked up by `bun run test:scripts`
 * automatically -- locally, by `ci.yml`'s `test` job, and by the
 * `.claude/skills/**`-scoped workflow PR #1474 added (this file itself
 * isn't under `.claude/`, but `test:scripts` globs `scripts/` too, so all
 * three paths run it).
 */

const IMPORT_OK_MARKER = 'IMPORT_OK';
const SUBPROCESS_TIMEOUT_MS = 15_000;

function discoverSmokeFiles(): string[] {
  const smokeDir = path.join(import.meta.dir, '..');
  const glob = new Glob('*.{ts,mjs}');
  return [...glob.scanSync({ cwd: smokeDir, onlyFiles: true })].sort();
}

async function importInSubprocess(absPath: string): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const code = `await import(${JSON.stringify(absPath)}); console.log(${JSON.stringify(IMPORT_OK_MARKER)});`;
  const proc = Bun.spawn([process.execPath, '-e', code], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SUBPROCESS_TIMEOUT_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  return { exitCode: timedOut ? null : exitCode, stdout: stdout.trim(), stderr, timedOut };
}

const smokeFiles = discoverSmokeFiles();

describe('scripts/smoke/* import safety (Issue #1479)', () => {
  it('discovers a non-trivial number of smoke scripts (the discovery glob itself is not silently empty)', () => {
    // A regression here (e.g. a glob pattern typo) would make every
    // per-file test below vacuously pass by never running -- this is the
    // same "an empty check-utils.js DEFAULT_GLOBS" shape #1463 and #1471
    // hit, applied to this pin's own discovery step.
    expect(smokeFiles.length).toBeGreaterThanOrEqual(20);
  });

  for (const file of smokeFiles) {
    // bun:test's own per-test timeout must exceed SUBPROCESS_TIMEOUT_MS, or
    // bun:test kills the test before this file's own timeout logic ever
    // gets to run -- measured directly: with the default 5000ms bun:test
    // timeout, a regressed script's failure showed up as a killed test
    // (exit 143) rather than this file's own `timedOut` assertion path.
    it(`${file}: importing it in a subprocess does not execute it`, async () => {
      const absPath = path.join(import.meta.dir, '..', file);
      const result = await importInSubprocess(absPath);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(IMPORT_OK_MARKER);
    }, SUBPROCESS_TIMEOUT_MS + 5_000);
  }
});
