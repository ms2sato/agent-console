/**
 * Registry pin for packages/server's real-fs second `bun test` invocation
 * (Issue #1699). Keeps `package.json`'s `test` / `test:coverage` two-half
 * chain honest in both directions and keeps every `assertRealFs(`-calling
 * test file inside the second half's list.
 *
 * Runs in the FIRST invocation -- deliberately reads `package.json` and the
 * repo's test-file source via `Bun.file()` / `Bun.spawn()` (grep), NEVER
 * `fs`/`fs/promises`/`node:fs`/`node:fs/promises`. Those four module
 * specifiers are what `mock-fs-helper.ts`'s `mock.module()` calls replace
 * process-globally with memfs's in-memory volume (see
 * `.claude/rules/testing.md` "Module-Level Mocking"); an `fs/promises`
 * import in THIS file would read from that empty virtual volume instead of
 * the real repository the moment it shares a process with a
 * mock-fs-helper importer, which is the ordinary case for a file living in
 * the first invocation. `Bun.file()` and `Bun.spawn()` are Bun-native
 * bindings that `mock.module('fs/promises', ...)` does not touch (same
 * rationale `workers-upload-dir-real-fs.test.ts` documents for its own
 * kernel-level probe), so this file reads the real repository regardless
 * of what ran before it in the same process.
 *
 * Bun 1.3.14 measurement (2026-09-21): `--path-ignore-patterns` accepts
 * REPEATED flags, each pattern applied independently. A single
 * comma-separated value is NOT split into multiple patterns -- bun treats
 * the whole string as one literal glob that matches nothing, which
 * SILENTLY excludes zero files (the run looks clean; it just includes
 * everything). `package.json`'s scripts therefore repeat the flag once per
 * real-fs file; check (ii) below fails loudly if a future edit collapses
 * that back into a comma-joined single flag -- see the 3rd polarity item.
 *
 * Polarity, measured 2026-09-21 (temporarily mutated, restored by
 * re-editing -- never via `git checkout`):
 *   - Adding a fake path to the second half's file list -> (i) fails.
 *   - Removing one `--path-ignore-patterns` flag from the first half ->
 *     (ii) fails (unmatched pattern count).
 *   - Rewriting the first half's three flags into one comma-joined flag
 *     (`--path-ignore-patterns '**\/a,**\/b,**\/c'`) -> (ii) fails (parsed
 *     as 1 pattern against 3 files -- the exact regression this pin exists
 *     to block; see the file's own top comment).
 *   - Adding `assertRealFs(` to an unlisted temp file under src/ -> (iii)
 *     fails.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/server/src/__tests__ -> packages/server
const SERVER_ROOT = join(__dirname, '..', '..');

interface TestScriptHalves {
  /** Glob patterns passed via --path-ignore-patterns in the first half. */
  ignorePatterns: string[];
  /** Explicit `src/...test.ts` paths listed as positional args in the second half. */
  secondHalfFiles: string[];
}

function parseTwoInvocationScript(script: string): TestScriptHalves {
  const halves = script.split('&&').map((s) => s.trim());
  if (halves.length !== 2) {
    throw new Error(`expected a two-invocation "bun test ... && bun test ..." script, got: ${script}`);
  }
  const [first, second] = halves;
  const ignorePatterns = [...first.matchAll(/--path-ignore-patterns\s+'([^']+)'/g)].map((m) => m[1]);
  const secondHalfFiles = [...second.matchAll(/(src\/\S+\.test\.ts)/g)].map((m) => m[1]);
  return { ignorePatterns, secondHalfFiles };
}

/** `'**\/<basename>'` -> does `path` end with `/<basename>` (or equal it)? */
function ignorePatternMatchesPath(pattern: string, path: string): boolean {
  if (!pattern.startsWith('**/')) return false;
  const basename = pattern.slice('**/'.length);
  return path === basename || path.endsWith('/' + basename);
}

async function readServerPackageJson(): Promise<{ scripts: Record<string, string> }> {
  const text = await Bun.file(join(SERVER_ROOT, 'package.json')).text();
  return JSON.parse(text) as { scripts: Record<string, string> };
}

/**
 * Every `src/**\/*.test.ts` path (relative to SERVER_ROOT) whose text
 * contains `assertRealFs(`. Uses `grep` via `Bun.spawn` rather than
 * `fs/promises` -- see the file header.
 */
async function findAssertRealFsCallers(): Promise<string[]> {
  const proc = Bun.spawn(['grep', '-rl', '--include=*.test.ts', 'assertRealFs(', 'src'], {
    cwd: SERVER_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // grep exits 1 when nothing matches -- that is a valid (if surprising)
  // outcome here, not an error. Only >1 is a real failure.
  if (exitCode > 1) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`grep failed (exit ${exitCode}): ${stderr}`);
  }
  // This registry file's OWN prose (this comment included) necessarily
  // contains the literal substring `assertRealFs(` while describing the
  // pattern -- it is never itself a caller, so exclude its own path
  // rather than let the grep produce a self-referential false positive.
  const OWN_RELATIVE_PATH = 'src/__tests__/real-fs-invocation.test.ts';
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => f !== OWN_RELATIVE_PATH);
}

describe('packages/server real-fs second `bun test` invocation registry (#1699)', () => {
  it('(i) every file listed in the second half of `test` exists, and the list is non-empty', async () => {
    const pkg = await readServerPackageJson();
    const { secondHalfFiles } = parseTwoInvocationScript(pkg.scripts.test);
    // Boundary value: an empty second half is a wiring error, not "nothing
    // to run" -- reject it explicitly rather than vacuously passing the
    // existence loop below.
    expect(secondHalfFiles.length).toBeGreaterThan(0);
    for (const file of secondHalfFiles) {
      expect(await Bun.file(join(SERVER_ROOT, file)).exists()).toBe(true);
    }
  });

  it("(ii) the first half's ignore patterns and the second half's files name exactly the same set", async () => {
    const pkg = await readServerPackageJson();
    const { ignorePatterns, secondHalfFiles } = parseTwoInvocationScript(pkg.scripts.test);
    expect(ignorePatterns.length).toBe(secondHalfFiles.length);
    for (const file of secondHalfFiles) {
      expect(ignorePatterns.some((p) => ignorePatternMatchesPath(p, file))).toBe(true);
    }
    for (const pattern of ignorePatterns) {
      expect(secondHalfFiles.some((f) => ignorePatternMatchesPath(pattern, f))).toBe(true);
    }
  });

  it('(iii) every assertRealFs(-calling test file is listed, and every listed file calls assertRealFs(', async () => {
    const pkg = await readServerPackageJson();
    const { secondHalfFiles } = parseTwoInvocationScript(pkg.scripts.test);
    const callers = await findAssertRealFsCallers();
    expect([...callers].sort()).toEqual([...secondHalfFiles].sort());
  });

  it("(iv) test:coverage's two halves name the same sets as test's two halves", async () => {
    const pkg = await readServerPackageJson();
    const testHalves = parseTwoInvocationScript(pkg.scripts.test);
    const coverageHalves = parseTwoInvocationScript(pkg.scripts['test:coverage']);
    expect([...coverageHalves.ignorePatterns].sort()).toEqual([...testHalves.ignorePatterns].sort());
    expect([...coverageHalves.secondHalfFiles].sort()).toEqual([...testHalves.secondHalfFiles].sort());
  });
});
