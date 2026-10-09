import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Shared discovery + entry-point detection for `scripts/smoke/*`, used by
 * every net that needs to enumerate smoke files: `registry-reachability
 * .test.ts`, `import-safety.test.ts`, and `node-env-discipline.test.ts`
 * (Issue #1289). Single writer, so the glob pattern and the content-based
 * entry-point guard cannot drift between nets that must agree on them.
 */

export const SMOKE_DIR = path.join(import.meta.dir, '..');

/**
 * A `scripts/smoke/*` file with no top-level `import.meta.main` guard is a
 * shared library, not a runnable entry point (per `test-trigger.md`'s
 * "Exceptions to the reachability rule") -- it is never invoked directly.
 * Content-based rather than a hand-maintained name list, so a future
 * library file is exempted automatically (Architect ruling, Issue #1637).
 */
export const ENTRY_POINT_GUARD = /import\.meta\.main/;

/** Sorted basenames of every `scripts/smoke/*.{ts,mjs}` file. */
export function discoverSmokeFiles(): string[] {
  const glob = new Glob('*.{ts,mjs}');
  return [...glob.scanSync({ cwd: SMOKE_DIR, onlyFiles: true })].sort();
}

export function readSmokeFile(file: string): string {
  return readFileSync(path.join(SMOKE_DIR, file), 'utf-8');
}

export function hasEntryPointGuard(file: string): boolean {
  return ENTRY_POINT_GUARD.test(readSmokeFile(file));
}
