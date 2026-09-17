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
 * The worktree tree's creator: `WorktreeService.createWorktree` builds
 * `<configDir>/repositories/<org>/<repo>/worktrees` -- the same
 * `repositories/<org>/<repo>` segments the session-data writers create,
 * under the same group-writable `repositories/` ancestor -- so it walks the
 * same chain from the same root. It is deliberately NOT in
 * `SESSION_DATA_WRITERS`: that list's rule is "zero recursive mkdir", and
 * this file legitimately keeps exactly one -- the in-process template sink
 * (`directFsSink.mkdir`, `mkdir(dirPath, { recursive: true })`), which
 * writes INSIDE a worktree that `git worktree add` has already created
 * (user-owned on the elevated path), a tree with no server-created
 * group-writable ancestor of its own, where nested template directories
 * need the recursion. The rule for this list is therefore "exactly one
 * recursive mkdir, and it is the sink", so the exemption is pinned by name
 * rather than by count alone.
 *
 * Reach measured: restoring `fsPromises.mkdir(repoWorktreeDir, { recursive:
 * true })` at the worktrees-dir site makes the count 2 and fails naming
 * both `services/worktree-service.ts:<line>` entries; deleting the sink's
 * own `mkdir` line makes the count 0 and also fails -- the pin refuses to
 * let the exemption silently widen or silently disappear. Replacing the
 * sink's `dirPath` argument with any other name also fails (the line-text
 * pin), so a second recursive mkdir cannot hide by taking the sink's place.
 */
const WORKTREE_TREE_WRITERS = ['services/worktree-service.ts'] as const;
const TEMPLATE_SINK_MKDIR = 'mkdir(dirPath, { recursive: true })';

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

  for (const relativePath of WORKTREE_TREE_WRITERS) {
    it(`${relativePath} contains exactly one recursive mkdir, and it is the template sink`, async () => {
      const content = await Bun.file(path.join(SRC_ROOT, relativePath)).text();
      expect(content.length).toBeGreaterThan(100);
      const lines = content.split('\n');
      // Pin the line that carries `recursive: true` (the END of the match),
      // not the match's start: the sink's `mkdir` is a method whose
      // declaration line (`async mkdir(dirPath) {`) precedes the call by one
      // line with no `;` between, so RECURSIVE_MKDIR's `[^;]*?` starts the
      // match at the declaration. The option line is the one that names
      // the call, in every shape.
      const found = [...content.matchAll(RECURSIVE_MKDIR)].map((m) => {
        const lineNumber = lineNumberAt(content, m.index + m[0].length);
        return { at: `${relativePath}:${lineNumber}`, text: lines[lineNumber - 1].trim() };
      });
      // One assertion over the whole list, so a failure prints every
      // offending `file:line` rather than a bare length mismatch.
      expect(found).toEqual([{ at: expect.any(String), text: expect.stringContaining(TEMPLATE_SINK_MKDIR) }]);
    });

    it(`${relativePath} imports the walker`, async () => {
      const content = await Bun.file(path.join(SRC_ROOT, relativePath)).text();
      expect(content).toContain('ensureTrustedDirChain');
    });
  }
});
