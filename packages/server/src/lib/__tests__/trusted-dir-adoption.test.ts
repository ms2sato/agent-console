import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * Grep-pinned adoption gate for the trusted-root walker
 * (docs/design/session-data-path.md section 2): every creator of a session
 * base directory or its ancestors goes through `ensureTrustedDirChain`,
 * which creates each segment NON-recursively and `lstat`-verifies it. The
 * shape it replaced -- `fs.mkdir(dir, { recursive: true })` -- follows a
 * pre-planted symlink at any ancestor under a group-writable data root, so
 * a writer that reintroduces it silently reopens the redirect. The four
 * files below are the complete set of session-data writers (worker output,
 * memos, inter-session messages, the memory layer's base); this test asserts
 * that no `mkdir` / `mkdirSync` call in any of them carries
 * `recursive: true`, so the regression fails CI by file name. The pin is
 * scoped to the mkdir shape rather than the bare substring because
 * `fs.rm(dir, { recursive: true, force: true })` -- directory DELETION --
 * legitimately carries the same option in two of these files
 * (`deleteContentFiles`' session-dir wipe, the message service's
 * `deleteSessionMessages` / `deleteWorkerMessages`), and a removal cannot
 * redirect a write. Sibling trees (`worktree-service.ts`,
 * `repository-clone-service.ts`, `persistence-service.ts`'s config-dir
 * creation) are deliberately not listed -- they create different trees and
 * are out of this gate's scope.
 *
 * Uses `Bun.file()` rather than `node:fs` deliberately: in the full server
 * suite `fs/promises` is process-globally swapped for memfs the moment a
 * sibling test file imports `mock-fs-helper.ts`, and a grep through the
 * mocked module would read nothing rather than fail loudly (same rationale
 * as `orchestrator-session-id-deadness.test.ts`).
 *
 * Reach measured: reintroducing `await fs.mkdir(dir, { recursive: true })`
 * at any one of the eight former worker-output-file.ts sites, or at the
 * memo / message / memory-dir site, fails this test naming that file and
 * line; the three surviving `fs.rm(..., { recursive: true, force: true })`
 * lines do NOT trip it (asserted below as the positive control).
 */
const SRC_ROOT = path.resolve(import.meta.dir, '../..');

const SESSION_DATA_WRITERS = [
  'lib/worker-output-file.ts',
  'lib/memory-dir.ts',
  'services/memo-service.ts',
  'services/inter-session-message-service.ts',
] as const;

/**
 * A `mkdir` / `mkdirSync` call whose argument list carries
 * `recursive: true`, bounded by the statement's `;`. The bound is the
 * statement, not the closing `)`, because the former worker-output-file.ts
 * shape was `fs.mkdir(path.dirname(filePath), { recursive: true })` -- a
 * nested call closes a `)` before the option appears, and a `[^)]*` bound
 * measured as missing exactly that shape. `[^;]*?` spans newlines, so a
 * call split across lines is matched too.
 */
const RECURSIVE_MKDIR = /\bmkdir(?:Sync)?\s*\([^;]*?recursive:\s*true/g;

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function findRecursiveMkdirs(content: string): number[] {
  return [...content.matchAll(RECURSIVE_MKDIR)].map((m) => lineNumberAt(content, m.index));
}

describe('trusted-root walker adoption (grep pin)', () => {
  // Positive control that the instrument can see the shape it is gating:
  // the exact former worker-output-file.ts shape, plus a multi-line one.
  it('the pattern matches the recursive-mkdir shape and ignores recursive rm', () => {
    expect(findRecursiveMkdirs('await fs.mkdir(dir, { recursive: true });')).toEqual([1]);
    expect(findRecursiveMkdirs('await fs.mkdir(path.dirname(filePath), { recursive: true });')).toEqual([1]);
    expect(findRecursiveMkdirs('x;\nawait mkdir(p, {\n  recursive: true,\n});')).toEqual([2]);
    expect(findRecursiveMkdirs('vol.mkdirSync(p, { recursive: true })')).toEqual([1]);
    expect(findRecursiveMkdirs('await fs.rm(dir, { recursive: true, force: true });')).toEqual([]);
  });

  for (const relativePath of SESSION_DATA_WRITERS) {
    it(`${relativePath} contains no recursive mkdir`, async () => {
      const content = await Bun.file(path.join(SRC_ROOT, relativePath)).text();
      // The file is real and non-trivial, so an empty read cannot pass as
      // "no occurrences".
      expect(content.length).toBeGreaterThan(100);
      const offending = findRecursiveMkdirs(content).map((lineNumber) => `${relativePath}:${lineNumber}`);
      expect(offending).toEqual([]);
    });
  }

  it('every writer imports the walker (the gate is adoption, not merely absence)', async () => {
    for (const relativePath of SESSION_DATA_WRITERS) {
      const content = await Bun.file(path.join(SRC_ROOT, relativePath)).text();
      expect(content).toContain('ensureTrustedDirChain');
    }
  });
});
