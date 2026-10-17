import { describe, it, expect, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverSmokeFiles } from './smoke-entry-points.js';

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

type EnvDiffReport = { envAdded: string[]; envRemoved: string[]; envChanged: string[] };

/**
 * Applies the KNOWN_BENIGN_ENV_KEYS exclusion to a raw env-diff report.
 * Scoped to `envAdded` only, matching exactly what was measured (the SDK
 * bundle ADDS this key, never removes or rewrites it) -- see
 * KNOWN_BENIGN_ENV_KEYS's own comment. `envRemoved`/`envChanged` are
 * returned untouched, on purpose: this key disappearing or being rewritten
 * during import would be a different, unverified, and more concerning
 * defect (something deleting/overwriting the SDK's own env write), and
 * must still fail the zero-drift assertion rather than being silently
 * allowlisted alongside its one verified, benign transition.
 */
function filterKnownBenignEnvAdditions<T extends EnvDiffReport>(report: T): T {
  return { ...report, envAdded: report.envAdded.filter((k) => !KNOWN_BENIGN_ENV_KEYS.has(k)) };
}

// `discoverSmokeFiles` is shared with `registry-reachability.test.ts` and
// `node-env-discipline.test.ts` via `./smoke-entry-points.js` -- single
// writer for the glob pattern.

interface ImportResult {
  exitCode: number | null;
  /** The terminating signal name when the runtime reports one (it may report only an `exitCode` of 128 + n instead). */
  signalCode: string | null;
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
  const signalCode = proc.signalCode;

  const trimmed = stdout.trim();
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  const reportLine = lines[lines.length - 2] ?? '';
  let report: ImportResult['report'] = null;
  try {
    report = JSON.parse(reportLine);
    if (report) {
      // Strip known-benign third-party side effects (see
      // filterKnownBenignEnvAdditions and KNOWN_BENIGN_ENV_KEYS above)
      // before this report is asserted on -- the whole point of route (b)
      // is attributing a mutation to THIS file's own code, and a key every
      // SDK-importing file sets identically is not that.
      report = filterKnownBenignEnvAdditions(report);
    }
  } catch {
    report = null;
  }

  return { exitCode: timedOut ? null : exitCode, signalCode, stdout: lastLine, stderr, timedOut, report };
}

const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_CHARS = 2000;

/** The name of signal number `n` from `os.constants.signals`, or null when it has none. */
function signalNameOf(n: number): string | null {
  const found = Object.entries(os.constants.signals).find(([, value]) => value === n);
  return found ? found[0] : null;
}

/**
 * One multi-line description of a failed import, so the FIRST failure names the crash instead of saying only
 * "Expected 0, Received 133". Pure: no I/O. It is the whole point of the diagnostics: a flake seen once
 * (an importer that exited 133, a SIGTRAP shape, after ~300 ms while the host was loaded) left nothing to compare
 * a recurrence against.
 *
 * The stderr tail keeps the LAST lines (a crash message is at the end) and, when the last 20 lines still exceed the
 * cap, keeps the last `STDERR_TAIL_MAX_CHARS` characters and says how many were cut.
 *
 * Why the signal has two paths: Bun reports a SIGTRAP self-kill as BOTH `exitCode` 133 and `signalCode` 'SIGTRAP', so
 * the derived name (128 + n) is only reached when a runtime reports the code alone; the signal-named wiring test
 * (a SIGKILL self-kill) and the exit(133) scratch test (the derivation path) cover the two cases separately.
 */
function describeImportFailure(file: string, route: 'a' | 'b', result: ImportResult): string {
  const derivedSignal =
    result.signalCode === null && result.exitCode !== null && result.exitCode >= 128
      ? signalNameOf(result.exitCode - 128)
      : null;
  const signal =
    result.signalCode !== null
      ? result.signalCode
      : derivedSignal !== null
        ? `none reported (exitCode ${result.exitCode} = 128 + ${(result.exitCode ?? 0) - 128} -> ${derivedSignal})`
        : 'none';

  const stderrLines = result.stderr.replace(/\n+$/, '').split('\n');
  let stderrTail = stderrLines.slice(-STDERR_TAIL_LINES).join('\n');
  if (stderrTail.length > STDERR_TAIL_MAX_CHARS) {
    const cut = stderrTail.length - STDERR_TAIL_MAX_CHARS;
    stderrTail = `...(${cut} more chars)\n${stderrTail.slice(cut)}`;
  }

  return [
    `Importing ${file} failed (route ${route})`,
    `exitCode: ${result.exitCode}`,
    `signalCode: ${signal}`,
    `timedOut: ${result.timedOut}`,
    `last stdout line: ${result.stdout === '' ? '(empty)' : result.stdout}`,
    `stderr (last ${STDERR_TAIL_LINES} lines, capped at ${STDERR_TAIL_MAX_CHARS} chars):`,
    stderrTail === '' ? '(empty)' : stderrTail,
  ].join('\n');
}

/**
 * The route-(a)/(b) wiring shared by both tests: a failed or timed-out import throws the described error BEFORE
 * the assertions that pin the success shape, so the first failure names the crash. Deliberately NOT a retry: a
 * retry would hide the flake this exists to catch.
 */
function assertImportSafe(file: string, route: 'a' | 'b', result: ImportResult): void {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(describeImportFailure(file, route, result));
  }
}

const smokeFiles = discoverSmokeFiles();

function baseResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return { exitCode: 0, signalCode: null, stdout: '', stderr: '', timedOut: false, report: null, ...overrides };
}

// Reach (measured, each mutation applied alone to this file and restored):
//   m1 drop the stderr tail from the describer -> the 50-line test, the cap test and the exit-133 wiring test fail;
//   m2 drop the signal derivation -> the "133 -> SIGTRAP" test and the exit-133 wiring test fail (a SIGKILL
//      self-kill is reported by Bun as a signal, so it does not exercise the derivation);
//   m3 remove the `throw` in assertImportSafe -> the two crash wiring tests fail (the SIGKILL describer-only
//      test still passes: it tests the describer, not the wiring).
//
// Why the scratch modules never self-kill with SIGTRAP (or SIGSEGV): on GitHub runners a core-dumping signal takes
// about 17 seconds to be reaped (9 of 9 runs, then 10 more at 15 s), because `core_pattern` pipes the dump to
// systemd-coredump and that helper runs even with `ulimit -c 0`; a SIGKILL or a plain exit takes 15 ms. Pointing
// `core_pattern` at a plain file brought the same SIGTRAP kill down to 14 ms, and neither `DO_NOT_TRACK` nor a dead
// `BUN_CRASH_REPORT_URL` changed the delay, so it is the core-dump helper, not Bun's crash report. The SIGTRAP name
// is still pinned: by the code-only derivation (exit 133 with no signal) and by the exit(133) wiring test.
describe('describeImportFailure (a recurrence of the exit-133 flake must name the crash)', () => {
  it('derives SIGTRAP from exit code 133 when no signal is reported, and shows the exit code', () => {
    const text = describeImportFailure('x.mjs', 'b', baseResult({ exitCode: 133 }));
    expect(text).toContain('SIGTRAP');
    expect(text).toContain('133');
    expect(text).toContain('x.mjs');
    expect(text).toContain('route b');
  });

  it('names a reported signal as is', () => {
    const text = describeImportFailure('x.mjs', 'a', baseResult({ exitCode: null, signalCode: 'SIGKILL' }));
    expect(text).toContain('SIGKILL');
    expect(text).toContain('route a');
  });

  it('shows only the last 20 stderr lines and the last stdout line', () => {
    const stderr = Array.from({ length: 50 }, (_, i) => `err-line-${i + 1}`).join('\n') + '\n';
    const text = describeImportFailure('x.mjs', 'b', baseResult({ exitCode: 1, stderr, stdout: 'last-out' }));
    expect(text).toContain('err-line-50');
    expect(text).toContain('err-line-31');
    expect(text).not.toContain('err-line-30');
    expect(text).toContain('last-out');
  });

  it('caps a very long stderr tail at 2000 characters and says how many were cut', () => {
    const stderr = `${'a'.repeat(3000)}\nthe-crash-message\n`;
    const text = describeImportFailure('x.mjs', 'b', baseResult({ exitCode: 1, stderr }));
    expect(text).toMatch(/\.\.\.\(\d+ more chars\)/);
    expect(text).toContain('the-crash-message');
    const tail = text.split('capped at 2000 chars):\n')[1] ?? '';
    expect(tail.length).toBeLessThanOrEqual(2000 + '...(1100 more chars)\n'.length);
  });

  it('returns a string for a clean result without throwing (boundary: it is not called in practice)', () => {
    const text = describeImportFailure('x.mjs', 'b', baseResult());
    expect(typeof text).toBe('string');
    expect(text).toContain('exitCode: 0');
    expect(text).toContain('(empty)');
  });
});

describe('failed imports are described through the same path as the discovered-script cases', () => {
  const tmpDirs: string[] = [];
  function scratchModule(source: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-safety-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'scratch.mjs');
    fs.writeFileSync(file, source);
    return file;
  }

  it('a module that kills itself with SIGKILL is reported as SIGKILL (a reported signal, not a code only)', async () => {
    const file = scratchModule("process.kill(process.pid, 'SIGKILL');\n");
    const result = await importInSubprocess(file);

    expect(result.signalCode).toBe('SIGKILL');
    expect(describeImportFailure('scratch.mjs', 'b', result)).toContain('SIGKILL');
  });

  it('assertImportSafe rejects with the SIGKILL description for a killed module (the wiring of route b)', async () => {
    const file = scratchModule("process.kill(process.pid, 'SIGKILL');\n");
    const result = await importInSubprocess(file);

    expect(() => assertImportSafe('scratch.mjs', 'b', result)).toThrow(/SIGKILL/);
  });

  it('assertImportSafe rejects with the 133 description for a module that exits 133 and prints to stderr', async () => {
    const file = scratchModule("console.error('boom-from-scratch');\nprocess.exit(133);\n");
    const result = await importInSubprocess(file);

    expect(() => assertImportSafe('scratch.mjs', 'a', result)).toThrow(/SIGTRAP[\s\S]*boom-from-scratch/);
  });

  it('assertImportSafe is silent for a module that imports cleanly', async () => {
    const file = scratchModule('export const ok = true;\n');
    const result = await importInSubprocess(file);

    expect(() => assertImportSafe('scratch.mjs', 'b', result)).not.toThrow();
  });

  // The scratch directories live under the OS temp dir and are removed here, not left behind.
  afterAll(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filterKnownBenignEnvAdditions (CodeRabbit follow-up: allowlist scope)', () => {
  const KEY = 'NoDefaultCurrentDirectoryInExePath';

  it('drops the known key from envAdded (the one verified, measured transition)', () => {
    const result = filterKnownBenignEnvAdditions({ envAdded: [KEY, 'OTHER'], envRemoved: [], envChanged: [] });
    expect(result.envAdded).toEqual(['OTHER']);
  });

  it('does NOT drop the known key from envRemoved -- an unverified transition must still fail', () => {
    const result = filterKnownBenignEnvAdditions({ envAdded: [], envRemoved: [KEY], envChanged: [] });
    expect(result.envRemoved).toEqual([KEY]);
  });

  it('does NOT drop the known key from envChanged -- an unverified transition must still fail', () => {
    const result = filterKnownBenignEnvAdditions({ envAdded: [], envRemoved: [], envChanged: [KEY] });
    expect(result.envChanged).toEqual([KEY]);
  });
});

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

      assertImportSafe(file, 'b', result);
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

      assertImportSafe(file, 'a', result);
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
