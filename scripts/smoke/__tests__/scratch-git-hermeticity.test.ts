import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Mechanical net for the scratch-git hermeticity discipline
 * (packages/server/src/__tests__/utils/scratch-git.ts): any TypeScript file
 * directly under `scripts/smoke`, nested inside any package's `src` tree's
 * `__tests__` directories, or one of `packages/integration/src`'s flat
 * `*.test.ts(x)` boundary tests (that package deliberately has no
 * `__tests__/` directory, per `test-trigger.md`'s exception, so the
 * `__tests__`-anchored glob below never reaches it on its own) that spawns
 * a git commit must import `scratch-git.ts` rather than committing against
 * the operator's own global git config -- see
 * `.claude/rules/os-environment-coupling.md` and `testing.md`'s "Scratch
 * git repositories" paragraph.
 *
 * Three shapes are detected, matching every commit-spawning site measured
 * on `main` at the time this net was written (plus one more, found by
 * CodeRabbit review, that a maintainer could plausibly write):
 *   1. A direct array literal: `Bun.spawn(['git', ..., 'commit', ...])`.
 *   2. A call through a `git`-PREFIXED locally-named wrapper:
 *      `git(['commit', ...])`, `scratchRepo.git(['commit', ...])` -- the
 *      wrapper's own array does not repeat the literal `'git'`, so this is
 *      a separate pattern from #1. Case-insensitive.
 *   3. A call through a `Git`-SUFFIXED wrapper, e.g. `runGit(['commit',
 *      ...])` -- notably the exact name of `scratch-git.ts`'s own internal
 *      low-level spawn function. Case-SENSITIVE on the capital `G`
 *      specifically so this does not also match `digit(...)` (whose last
 *      three characters spell "git" but are not a wrapper name at all).
 *
 * Glob-driven (not a hardcoded list), same convention as
 * `registry-reachability.test.ts`: a future new smoke or test file that
 * commits in a scratch repo is covered automatically, with no separate
 * registration step for this specific check.
 *
 * Polarity (measured during implementation): temporarily adding a bare
 * `Bun.spawnSync(['git', 'commit', '-m', 'x'])` line to a smoke that does
 * not import scratch-git.ts flips the corresponding per-file test from
 * pass to fail. Separately measured for shape #3: a bare `function
 * runGit(): void { Bun.spawnSync(['x']); } runGit(['commit', ...]);`-shaped
 * snippet (never calling a real `git` binary -- the pattern only reads
 * source text) added to a smoke without the import also flips its test.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

const COMMIT_ARRAY_PATTERN = /\[\s*['"]git['"][\s\S]{0,200}?['"]commit['"]/;
// Two separately-flagged patterns rather than one alternation: the PREFIX
// form is case-insensitive (git(/Git(/GIT( are all wrapper-shaped), but the
// SUFFIX form must stay case-SENSITIVE on a literal capital `Git` -- under
// a case-insensitive flag, `\w*Git` would also match "digit(" (the last
// three characters happen to spell "git"). Requiring the camelCase-style
// capital G on the suffix side (as in `runGit`, matching this very
// helper's own internal `runGit` spawn function name) avoids that without
// losing coverage: nobody names a wrapper "digit" for git commands.
const WRAPPER_PREFIX_PATTERN = /\bgit\w*\(\s*\[[\s\S]{0,200}?['"]commit['"]/i;
const WRAPPER_SUFFIX_PATTERN = /\b\w*Git\(\s*\[[\s\S]{0,200}?['"]commit['"]/;
const IMPORT_PATTERN = /from\s+['"][^'"]*scratch-git(?:\.js)?['"]/;

/**
 * Allowlist, each entry with a stated reason (AC item 5). Paths are
 * relative to REPO_ROOT. The two non-`.ts` entries below are already
 * outside this test's own glob scope by extension (`.mjs` and `.sh` are
 * never scanned) -- they are listed anyway, verbatim per the Issue's own
 * wording, as documentation of why they are not migrated to the helper.
 */
const ALLOWLIST: Record<string, string> = {
  'packages/server/src/__tests__/utils/scratch-git.ts':
    "the helper's own definition file -- it implements the initial commit internally (AC item 1(e)) and does not import itself",
  'scripts/__tests__/install-hooks.test.mjs':
    'node, cannot import TypeScript -- sets GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM inline for its one commit spawn instead, with a comment naming scratch-git.ts as the single writer of the TS-importable version',
  'scripts/verify-multiuser-docker.sh':
    'shell in the container -- commits inside the disposable container filesystem, which has no host global git config to inherit from',
};

function discoverCandidateFiles(): string[] {
  const files: string[] = [];
  {
    const glob = new Glob('*.ts');
    for (const f of glob.scanSync({ cwd: path.join(REPO_ROOT, 'scripts/smoke'), onlyFiles: true })) {
      files.push(path.join('scripts/smoke', f));
    }
  }
  {
    const glob = new Glob('packages/*/src/**/__tests__/**/*.ts');
    for (const f of glob.scanSync({ cwd: REPO_ROOT, onlyFiles: true })) {
      files.push(f);
    }
  }
  {
    // packages/integration/src/ uses a deliberate flat layout (no
    // __tests__/ directory, per test-trigger.md's exception for its
    // boundary tests), so the __tests__-anchored glob above never reaches
    // it. Scanned separately by its own *.test.ts(x) naming convention.
    const glob = new Glob('packages/integration/src/**/*.test.ts');
    for (const f of glob.scanSync({ cwd: REPO_ROOT, onlyFiles: true })) {
      files.push(f);
    }
  }
  {
    const glob = new Glob('packages/integration/src/**/*.test.tsx');
    for (const f of glob.scanSync({ cwd: REPO_ROOT, onlyFiles: true })) {
      files.push(f);
    }
  }
  return files.sort();
}

function spawnsGitCommit(content: string): boolean {
  return (
    COMMIT_ARRAY_PATTERN.test(content) ||
    WRAPPER_PREFIX_PATTERN.test(content) ||
    WRAPPER_SUFFIX_PATTERN.test(content)
  );
}

function importsScratchGit(content: string): boolean {
  return IMPORT_PATTERN.test(content);
}

describe('scratch git hermeticity net', () => {
  const candidateFiles = discoverCandidateFiles();

  it('discovers a non-trivial number of candidate files (the discovery glob itself is not silently empty)', () => {
    expect(candidateFiles.length).toBeGreaterThan(0);
  });

  const commitSpawningFiles = candidateFiles.filter((f) =>
    spawnsGitCommit(readFileSync(path.join(REPO_ROOT, f), 'utf-8')),
  );

  it('finds at least the known commit-spawning sites (the detection pattern itself is not silently empty)', () => {
    // Floor derived from what is on `main` at the time this net was
    // written: the helper's own file and the migrated
    // git-diff-base-reresolve.test.ts (the sibling test scratch-git.test.ts
    // also matches). A future migration only grows this.
    expect(commitSpawningFiles.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of commitSpawningFiles) {
    it(`${file} spawns a git commit and must import scratch-git.ts, or be an explicitly allowlisted exception`, () => {
      const allowReason = ALLOWLIST[file];
      if (allowReason !== undefined) {
        expect(allowReason.length).toBeGreaterThan(0);
        return;
      }
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf-8');
      expect(importsScratchGit(content)).toBe(true);
    });
  }

  it('every allowlisted .ts file still exists and its exception reason is non-empty (no stale entries)', () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(0);
      if (file.endsWith('.ts')) {
        expect(() => readFileSync(path.join(REPO_ROOT, file), 'utf-8')).not.toThrow();
      }
    }
  });
});
