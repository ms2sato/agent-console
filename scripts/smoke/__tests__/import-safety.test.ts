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
 *
 * TWO ROUTES THIS PIN INITIALLY MISSED (found by CodeRabbit + a self-sweep
 * on PR #1481, after the first version of this pin -- and every script it
 * covered -- had already been marked "fixed"):
 *
 *   1. A "successful" import can still silently mutate the importer's
 *      environment or cwd (`process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS`,
 *      `process.chdir('/')`, `process.env.CLAUDE_CONFIG_DIR` plus a real
 *      directory created on disk). `IMPORT_OK` + exit 0 answers "did it
 *      crash the importer", not "did it leave the importer's process state
 *      alone" -- those are different questions, and the first version of
 *      this pin only asked the first one. Closed by ROUTE (b) below: every
 *      import is checked for env/cwd drift, not just for surviving.
 *   2. An argv parser guarded by nothing but its own position at module
 *      scope only executes -- and only `process.exit(2)`s -- when the
 *      IMPORTER's own `process.argv` happens to contain something it
 *      doesn't recognize. A bare `bun -e '<code>'` subprocess has no extra
 *      argv, so this path was structurally unreachable by the first version
 *      of this pin: it could not have caught any of these regardless of how
 *      many assertions were added to the no-argv case. Closed by ROUTE (a)
 *      below: every script is ALSO imported with a hostile trailing
 *      argument appended to the subprocess's own argv.
 *
 * Neither closes the other -- a script can pass one route and fail the
 * other independently (this was measured, not assumed: see the polarity
 * section of PR #1481's body for which of the 5 regressed files failed
 * which route, and where each fell through the original pin's coverage
 * gap on the hostile-argv route specifically because that route did not
 * exist yet).
 */

const IMPORT_OK_MARKER = 'IMPORT_OK';
const SUBPROCESS_TIMEOUT_MS = 15_000;
/**
 * Deliberately not a real flag any current smoke recognizes -- the point is
 * to look, to an argv-based parser, like an unrecognized/invalid argument,
 * which is exactly the shape that trips a module-scope `process.exit(2)`.
 */
const HOSTILE_ARG = '--pin-import-safety-hostile-arg-8f3a2b1c';

/**
 * `@anthropic-ai/claude-agent-sdk`'s own vendored bundle
 * (`packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`)
 * contains a bare, unconditional `process.env.NoDefaultCurrentDirectoryInExePath="1"`
 * at module scope -- confirmed by grepping the bundle directly. Every file
 * that imports the SDK or `sdk-engine.js` (which imports the SDK) sets this
 * key merely by being imported; no restructuring on this repo's side can
 * prevent it, because the statement lives in third-party code, not ours.
 *
 * This does not reproduce locally because most dev shells already carry
 * this key ambiently (set by whatever earlier `child_process` use touched
 * it first), so a pre-fix `envBefore` already contains it and it is never
 * seen as "added". A clean CI runner starts without it, which is why this
 * surfaced there and not in local runs -- reproduced locally by unsetting
 * the key before importing: `env -u NoDefaultCurrentDirectoryInExePath bun
 * -e "await import('./packages/embedded-agent/src/sdk-engine.js')"` adds it
 * even with zero project code executing.
 *
 * Excluded here as a known, verified-benign third-party runtime artifact --
 * not a smoke-script defect. Keep this set to exactly the keys measured
 * this way; it is not a general escape hatch for future findings.
 */
const KNOWN_BENIGN_ENV_KEYS = new Set(['NoDefaultCurrentDirectoryInExePath']);

function discoverSmokeFiles(): string[] {
  const smokeDir = path.join(import.meta.dir, '..');
  const glob = new Glob('*.{ts,mjs}');
  return [...glob.scanSync({ cwd: smokeDir, onlyFiles: true })].sort();
}

interface ImportResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Parsed from the subprocess's own JSON report line, when present. */
  report: { ok: boolean; envAdded: string[]; envRemoved: string[]; envChanged: string[]; cwdChanged: boolean } | null;
}

/**
 * ROUTE (a) applies when `extraArgv` is non-empty: `bun -e <code> <...>`
 * appends everything after the code string to `process.argv` starting at
 * index 1 (there is no "script path" slot the way there is for a direct
 * `bun script.ts arg1` invocation) -- so `argvPad` below inserts one filler
 * element first, making the subprocess's `process.argv.slice(2)` see
 * `extraArgv` at the same offset a directly-run smoke script would.
 *
 * ROUTE (b) is always active: the subprocess snapshots its own
 * `process.env` and `process.cwd()` before and after the import and reports
 * the diff as JSON, so a "successful" import that silently mutated either
 * is distinguishable from one that truly left the importer alone.
 */
async function importInSubprocess(absPath: string, extraArgv: string[] = []): Promise<ImportResult> {
  const code = `
    const envBefore = { ...process.env };
    const cwdBefore = process.cwd();
    await import(${JSON.stringify(absPath)});
    const envAfter = process.env;
    const cwdAfter = process.cwd();
    const envAdded = Object.keys(envAfter).filter((k) => !(k in envBefore));
    const envRemoved = Object.keys(envBefore).filter((k) => !(k in envAfter));
    const envChanged = Object.keys(envBefore).filter((k) => k in envAfter && envAfter[k] !== envBefore[k]);
    console.log(JSON.stringify({ ok: true, envAdded, envRemoved, envChanged, cwdChanged: cwdBefore !== cwdAfter }));
    console.log(${JSON.stringify(IMPORT_OK_MARKER)});
  `;
  const argvPad = extraArgv.length > 0 ? ['pin-argv-placeholder', ...extraArgv] : [];
  const proc = Bun.spawn([process.execPath, '-e', code, ...argvPad], {
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

  const trimmed = stdout.trim();
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  const reportLine = lines[lines.length - 2] ?? '';
  let report: ImportResult['report'] = null;
  try {
    report = JSON.parse(reportLine);
    if (report) {
      // Strip known-benign third-party side effects (see
      // KNOWN_BENIGN_ENV_KEYS above) before this report is asserted on --
      // the whole point of route (b) is attributing a mutation to THIS
      // file's own code, and a key every SDK-importing file sets
      // identically is not that.
      report.envAdded = report.envAdded.filter((k) => !KNOWN_BENIGN_ENV_KEYS.has(k));
      report.envRemoved = report.envRemoved.filter((k) => !KNOWN_BENIGN_ENV_KEYS.has(k));
      report.envChanged = report.envChanged.filter((k) => !KNOWN_BENIGN_ENV_KEYS.has(k));
    }
  } catch {
    report = null;
  }

  return { exitCode: timedOut ? null : exitCode, stdout: lastLine, stderr, timedOut, report };
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
    const testTimeout = SUBPROCESS_TIMEOUT_MS + 5_000;

    it(`${file}: importing it does not execute it, and leaves env/cwd unchanged (route b)`, async () => {
      const absPath = path.join(import.meta.dir, '..', file);
      const result = await importInSubprocess(absPath);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(IMPORT_OK_MARKER);
      expect(result.report).not.toBeNull();
      expect(result.report?.envAdded ?? ['<no report>']).toEqual([]);
      expect(result.report?.envRemoved ?? ['<no report>']).toEqual([]);
      expect(result.report?.envChanged ?? ['<no report>']).toEqual([]);
      expect(result.report?.cwdChanged).toBe(false);
    }, testTimeout);

    it(`${file}: importing it with a hostile trailing argv entry still does not execute it (route a)`, async () => {
      const absPath = path.join(import.meta.dir, '..', file);
      const result = await importInSubprocess(absPath, [HOSTILE_ARG]);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(IMPORT_OK_MARKER);
      expect(result.report).not.toBeNull();
      expect(result.report?.envAdded ?? ['<no report>']).toEqual([]);
      expect(result.report?.envRemoved ?? ['<no report>']).toEqual([]);
      expect(result.report?.envChanged ?? ['<no report>']).toEqual([]);
      expect(result.report?.cwdChanged).toBe(false);
    }, testTimeout);
  }
});
