import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Reachability pin for Issue #1637: `scripts/smoke/*` has exactly one way
 * to be registered (an Additional Verification section in
 * `.claude/rules/test-trigger.md`) and exactly one way to be invoked
 * (`bun scripts/smoke/<file>`, no `package.json` `check:` alias). This file
 * mechanically enforces both halves of that contract:
 *
 *   1. Every `scripts/smoke/*.{ts,mjs}` basename (except a documented
 *      non-entry-point exception) must appear in `test-trigger.md` -- a
 *      script nobody can find is a script nobody re-runs (Issue #671).
 *   2. Every `bun run check:<name>` reference anywhere under `docs/` or
 *      `.claude/` must resolve to an actually-defined `package.json`
 *      script -- a dangling alias reference is exactly as unreachable as
 *      an unregistered smoke, just in the opposite direction.
 *
 * Glob-driven (not a hardcoded list), same convention as the sibling
 * `import-safety.test.ts`: a future 34th smoke or a future doc reference is
 * covered automatically, with no separate registration step for this pin.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const TEST_TRIGGER_MD_PATH = path.join(REPO_ROOT, '.claude/rules/test-trigger.md');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

/**
 * A `scripts/smoke/*` file with no top-level `import.meta.main` guard is a
 * shared library, not a runnable entry point (per test-trigger.md's
 * "Exceptions to the reachability rule") -- it is never invoked directly,
 * so it needs no Additional Verification section of its own. Deriving the
 * exemption from CONTENT rather than a hand-maintained name list means a
 * future library file is exempted automatically and a future genuinely-
 * unregistered SCRIPT (which necessarily has the guard) cannot slip into
 * this bucket by being added to a list (Architect ruling, Issue #1637).
 */
const ENTRY_POINT_GUARD = /import\.meta\.main/;

/**
 * Floor derived from the count measured on `main` at the time this pin was
 * written (34 total smoke files, 33 with the guard). If a future change
 * makes the content-based exemption swallow more files than this, that is
 * itself a finding -- see the "is not silently empty of real exceptions"
 * test below.
 */
const MIN_REGISTERED_COUNT = 33;

function discoverSmokeFiles(): string[] {
  const smokeDir = path.join(REPO_ROOT, 'scripts/smoke');
  const glob = new Glob('*.{ts,mjs}');
  return [...glob.scanSync({ cwd: smokeDir, onlyFiles: true })].sort();
}

function hasEntryPointGuard(file: string): boolean {
  const content = readFileSync(path.join(REPO_ROOT, 'scripts/smoke', file), 'utf-8');
  return ENTRY_POINT_GUARD.test(content);
}

function walkFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

describe('scripts/smoke/* registered in test-trigger.md (Issue #1637)', () => {
  const testTriggerContent = readFileSync(TEST_TRIGGER_MD_PATH, 'utf-8');
  const smokeFiles = discoverSmokeFiles();

  it('discovers a non-trivial number of smoke scripts (the discovery glob itself is not silently empty)', () => {
    // Same shape as import-safety.test.ts's own guard: a regression in the
    // glob pattern would make every per-file assertion below vacuously
    // pass by never running.
    expect(smokeFiles.length).toBeGreaterThanOrEqual(20);
  });

  const registered = smokeFiles.filter(hasEntryPointGuard);
  const exempt = smokeFiles.filter((f) => !hasEntryPointGuard(f));

  it('the content-based exemption is not silently empty of real exceptions and not silently swallowing everything', () => {
    // Boundary check on the exemption mechanism itself: at least one real
    // file must be exempt (the harness), and the registered count must not
    // fall below the floor measured on main -- a future guard-stripping
    // change (accidental or malicious) that exempts a real script is
    // caught here rather than by silently skipping its registration check.
    expect(exempt.length).toBeGreaterThanOrEqual(1);
    expect(registered.length).toBeGreaterThanOrEqual(MIN_REGISTERED_COUNT);
  });

  for (const file of registered) {
    it(`${file} is named in test-trigger.md`, () => {
      expect(testTriggerContent).toContain(file);
    });
  }

  for (const file of exempt) {
    it(`${file} has no import.meta.main guard, so it is a documented non-entry-point exception, itself named in test-trigger.md's Exceptions section`, () => {
      expect(testTriggerContent).toContain(file);
    });
  }
});

describe('every `bun run check:<name>` reference under docs/ and .claude/ resolves to a package.json script (Issue #1637)', () => {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as { scripts?: Record<string, string> };
  const definedAliases = new Set(Object.keys(packageJson.scripts ?? {}));

  const scannedFiles = [
    ...walkFiles(path.join(REPO_ROOT, 'docs'), ['.md']),
    ...walkFiles(path.join(REPO_ROOT, '.claude'), ['.md', '.js', '.mjs']),
    path.join(REPO_ROOT, 'README.md'),
  ];

  const CHECK_REF_PATTERN = /bun run (check:[a-z0-9-]+)/g;

  const references: { file: string; alias: string }[] = [];
  for (const file of scannedFiles) {
    const content = readFileSync(file, 'utf-8');
    for (const match of content.matchAll(CHECK_REF_PATTERN)) {
      references.push({ file: path.relative(REPO_ROOT, file), alias: match[1] });
    }
  }

  it('discovers a non-trivial number of `bun run check:*` references (the scan itself is not silently empty)', () => {
    // Same "empty discovery masks every assertion below" shape as the
    // smoke-file glob guard above -- workflow.md sub-pattern 9.
    expect(references.length).toBeGreaterThanOrEqual(3);
  });

  const seen = new Set<string>();
  for (const { file, alias } of references) {
    const key = `${file}:${alias}`;
    if (seen.has(key)) continue;
    seen.add(key);
    it(`${file}: \`bun run ${alias}\` resolves to a defined package.json script`, () => {
      expect(definedAliases.has(alias)).toBe(true);
    });
  }
});
