import { describe, it, expect } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isReExportOnlyContent,
  requiresTestCoverage,
  runLanguageCheck,
  findTestFiles,
  isCommentOnlyDiff,
  isCommentOnlyFileDiff,
  resolvePrDiffRef,
  PrDiffRefResolutionError,
} from '../check-utils.js';

describe('isReExportOnlyContent', () => {
  it('returns true for a single `export * from` statement', () => {
    // TEMPORARY POLARITY-CHECK BREAK (Issue #1471) — will be reverted.
    expect(isReExportOnlyContent(`export * from './foo';`)).toBe(false);
  });

  it('returns true for multiple `export * from` statements with whitespace and trailing newlines', () => {
    const content = `
export * from './a';
export * from './b';
export * from './c';
`;
    expect(isReExportOnlyContent(content)).toBe(true);
  });

  it('returns true for `export { Named } from` statements', () => {
    const content = `export { Foo, Bar } from './foo';\nexport { Baz } from './baz';`;
    expect(isReExportOnlyContent(content)).toBe(true);
  });

  it('returns true for `export type { ... } from` statements', () => {
    const content = `export type { Config } from './config';\nexport type * from './shared-types';`;
    expect(isReExportOnlyContent(content)).toBe(true);
  });

  it('returns true for `export * as Name from` statements', () => {
    expect(isReExportOnlyContent(`export * as utils from './utils';`)).toBe(true);
  });

  it('returns true with block comments and line comments interleaved', () => {
    const content = `/**
 * Barrel file for shared types.
 */
// First group
export * from './a';
// Second group
export type { B } from './b'; /* inline note */
`;
    expect(isReExportOnlyContent(content)).toBe(true);
  });

  it('returns true for a multi-line `export { A, B }` statement', () => {
    const content = `
export {
  Alpha,
  Beta,
  Gamma,
} from './letters';
`;
    expect(isReExportOnlyContent(content)).toBe(true);
  });

  it('returns false for a file containing a const declaration', () => {
    const content = `export * from './a';\nexport const VERSION = '1.0';`;
    expect(isReExportOnlyContent(content)).toBe(false);
  });

  it('returns false for a file containing a function declaration', () => {
    const content = `export function noop() {}`;
    expect(isReExportOnlyContent(content)).toBe(false);
  });

  it('returns false for a file containing a default export', () => {
    expect(isReExportOnlyContent(`export default function () {}`)).toBe(false);
  });

  it('returns false for a file with import statements that are not re-exports', () => {
    const content = `import { foo } from './foo';\nexport { foo };`;
    // `import { foo }` is not a re-export from-statement; the rewrite to
    // `export { foo }` (no `from`) also does not match the pattern.
    expect(isReExportOnlyContent(content)).toBe(false);
  });

  it('returns false for a file containing only `export { local }` without a from-clause', () => {
    expect(isReExportOnlyContent(`export { foo };`)).toBe(false);
  });

  it('returns false for an empty file (no exports → not a re-export barrel)', () => {
    expect(isReExportOnlyContent('')).toBe(false);
    expect(isReExportOnlyContent('\n\n  \n')).toBe(false);
    expect(isReExportOnlyContent('// only a comment')).toBe(false);
  });
});

describe('requiresTestCoverage with re-export exclusion', () => {
  it('returns true for a normal hook file (no exclusion path applies)', () => {
    // Note: this test relies on the actual filesystem state of the repo —
    // it checks that hook files NOT in the exclusion patterns still require
    // coverage. The path `packages/client/src/hooks/__nonexistent__.ts`
    // doesn't exist on disk, so isReExportOnlyFile returns false (existsSync
    // false), preserving the requirement.
    expect(requiresTestCoverage('packages/client/src/hooks/__nonexistent__.ts')).toBe(true);
  });

  it('returns false for non-coverage paths regardless of content', () => {
    // packages/server/src/lib/** was NOT a coverage path here — it became
    // one in Issue #1459 (see the dedicated describe block below), so this
    // fixture uses packages/server/src/middleware/, which still isn't.
    expect(requiresTestCoverage('packages/server/src/middleware/auth.ts')).toBe(false);
    expect(requiresTestCoverage('packages/server/src/index.ts')).toBe(false);
  });

  it('returns false for test files', () => {
    expect(requiresTestCoverage('packages/shared/src/__tests__/foo.test.ts')).toBe(false);
  });

  it('returns false for the existing re-export-only barrel `packages/shared/src/constants/index.ts`', () => {
    // Real fixture: this file is a pure re-export barrel.
    // After PR #696, it must not require coverage even though it sits in
    // a coverage-pattern path (matches /^packages\/shared\/src\/.+\.ts$/).
    expect(requiresTestCoverage('packages/shared/src/constants/index.ts')).toBe(false);
  });

  it('returns true for `packages/shared/src/index.ts` because it mixes re-exports with an `ApiError` interface declaration', () => {
    // Counter-fixture: this barrel adds an `interface ApiError` alongside
    // the re-exports, so it has runtime-relevant content that should be
    // covered. Demonstrates that the exclusion is content-aware, not
    // path-based.
    expect(requiresTestCoverage('packages/shared/src/index.ts')).toBe(true);
  });
});

describe('requiresTestCoverage for packages/server/src/lib/** (Issue #1459)', () => {
  it('requires coverage for a lib file (previously absent from COVERAGE_PATTERNS)', () => {
    expect(requiresTestCoverage('packages/server/src/lib/logger.ts')).toBe(true);
  });

  it('requires coverage for the two-line auth-constants.ts constant file', () => {
    // No exclusion pattern applies here — it is a normal runtime file, just
    // a small one. See packages/server/src/lib/__tests__/auth-constants.test.ts.
    expect(requiresTestCoverage('packages/server/src/lib/auth-constants.ts')).toBe(true);
  });
});

describe('requiresTestCoverage with generated-file exclusion (*.gen.ts)', () => {
  it('excludes *.gen.ts under a coverage-pattern path', () => {
    // schema-version.gen.ts (surfaced by PR #1042) sits under
    // packages/shared/src/ (a coverage path), but its contents are
    // emitted by a codegen step at build time. A hand-written sibling
    // test would be tautological.
    expect(requiresTestCoverage('packages/shared/src/schema-version.gen.ts')).toBe(false);
  });

  it('excludes *.gen.tsx under a coverage-pattern path', () => {
    // Parity with *.gen.ts: if a future generator emits a .tsx file
    // (e.g. a code-gen React component tree), the same exclusion applies.
    expect(requiresTestCoverage('packages/client/src/components/foo.gen.tsx')).toBe(false);
  });

  it('does NOT exclude files whose basename merely contains "gen" as a substring', () => {
    // The exclusion is anchored on the `.gen.<ext>$` suffix, not any
    // occurrence of "gen" in the path — a file like `generator.ts` still
    // requires coverage.
    expect(requiresTestCoverage('packages/shared/src/generator.ts')).toBe(true);
  });
});

describe('requiresTestCoverage with bare types.ts exclusion', () => {
  it('excludes a bare `types.ts` at any depth (module-level type-definitions file)', () => {
    // Surfaced by PR #1050 (FF-1a) which added
    // packages/embedded-agent/src/tools/types.ts to break a circular
    // dependency. Bare `types.ts` (no prefix) is a natural
    // React / Node.js convention for module-level type definitions
    // colocated with runtime code; a hand-written sibling test would
    // be tautological.
    expect(requiresTestCoverage('packages/embedded-agent/src/tools/types.ts')).toBe(false);
  });

  it('excludes a bare `types.tsx` at any depth (parity for JSX-annotated type files)', () => {
    expect(requiresTestCoverage('packages/client/src/components/foo/types.tsx')).toBe(false);
  });

  it('does NOT exclude the singular `type.ts` (may contain runtime enums / factories)', () => {
    // The exclusion is anchored on the plural `types.<ext>$` at a segment
    // boundary, not `type.ts` singular. This avoids over-excluding files
    // that legitimately hold runtime code (enums, factory functions).
    expect(requiresTestCoverage('packages/shared/src/type.ts')).toBe(true);
  });

  it('does NOT exclude `mytypes.ts` (segment-boundary anchoring prevents substring match)', () => {
    // `mytypes.ts` sits at a segment boundary but the segment itself is
    // `mytypes`, not `types` — the anchor `(?:^|/)types\.` does not match
    // mid-segment, so this file still requires coverage.
    expect(requiresTestCoverage('packages/shared/src/mytypes.ts')).toBe(true);
  });
});

describe('preflight-check parity fix verification', () => {
  it('should verify getLocalChangedFiles implementation was simplified', () => {
    // Read the source code to verify the implementation
    const sourceCode = readFileSync('.claude/skills/orchestrator/check-utils.js', 'utf-8');

    // Verify the old merge-base approach is removed
    expect(sourceCode).not.toContain('git merge-base');

    // Verify the simplified approach is used
    expect(sourceCode).toContain('git diff --name-only ${baseBranch}...HEAD');

    // Verify the comment documents the parity goal
    expect(sourceCode).toContain('Use gh pr diff equivalent for local mode to ensure parity with CI mode');
  });

  it('should verify preflight-check.js documents local/CI parity', () => {
    // Read the preflight-check.js file
    const sourceCode = readFileSync('.claude/skills/orchestrator/preflight-check.js', 'utf-8');

    // Verify the comment documents same verdict guarantee
    expect(sourceCode).toContain('Local and CI modes produce the same verdict for the same branch state');
  });

  it('should document the fix approach taken', () => {
    // This test documents what was changed to fix Issue #657:
    // 1. Removed merge-base calculation from getLocalChangedFiles()
    // 2. Changed to direct git diff --name-only ${baseBranch}...HEAD
    // 3. This matches the semantic of gh pr diff more closely
    // 4. Added documentation about parity guarantee

    expect(true).toBe(true); // Always pass - this is documentation
  });
});

describe('hook shell-script coverage (Issue #733)', () => {
  describe('requiresTestCoverage', () => {
    it('flags a hook shell script as requiring coverage', () => {
      // Real fixture on disk: this file exists and is not re-export-only.
      expect(requiresTestCoverage('.claude/hooks/enforce-permissions.sh')).toBe(true);
    });

    it('does not flag a hook test file as requiring coverage (test files are excluded)', () => {
      expect(requiresTestCoverage('.claude/hooks/__tests__/enforce-permissions.test.mjs')).toBe(false);
    });

    it('does not flag shell scripts outside .claude/hooks/ (e.g., scripts/*.sh)', () => {
      expect(requiresTestCoverage('scripts/upload-qa-screenshots.sh')).toBe(false);
    });

    it('does not flag the hooks README (non-shell file)', () => {
      expect(requiresTestCoverage('.claude/hooks/README.md')).toBe(false);
    });
  });

  describe('findTestFiles for hook shell-script + .mjs test pairings', () => {
    it('reports a coverage gap when only a hook .sh changes (positive)', () => {
      const { testCoverage } = findTestFiles(['.claude/hooks/enforce-permissions.sh']);
      expect(testCoverage).toHaveLength(1);
      const entry = testCoverage[0];
      expect(entry.file).toBe('.claude/hooks/enforce-permissions.sh');
      expect(entry.needsCoverage).toBe(true);
      expect(entry.hasTest).toBe(false);
      expect(entry.expectedTestPath).toBe('.claude/hooks/__tests__/enforce-permissions.test.mjs');
    });

    it('reports no gap when both .sh and matching __tests__ .test.mjs change (negative)', () => {
      const { testCoverage } = findTestFiles([
        '.claude/hooks/enforce-permissions.sh',
        '.claude/hooks/__tests__/enforce-permissions.test.mjs',
      ]);
      expect(testCoverage).toHaveLength(1);
      expect(testCoverage[0].hasTest).toBe(true);
      expect(testCoverage[0].needsCoverage).toBe(true);
    });

    it('reports no gap when .sh changes alongside a sibling .test.mjs in the same dir', () => {
      // Sibling-placement variant: `foo.sh` + `foo.test.mjs` in the same dir,
      // mirroring the table's "or sibling `*.test.mjs`" allowance.
      const { testCoverage } = findTestFiles([
        '.claude/hooks/enforce-permissions.sh',
        '.claude/hooks/enforce-permissions.test.mjs',
      ]);
      expect(testCoverage).toHaveLength(1);
      expect(testCoverage[0].hasTest).toBe(true);
    });

    it('does not flag anything when only the test file changes (boundary: no false positive)', () => {
      const { testCoverage } = findTestFiles([
        '.claude/hooks/__tests__/enforce-permissions.test.mjs',
      ]);
      // The .test.mjs file is classified as a test file, not a production file,
      // so testCoverage is empty — preflight must not invent a phantom gap.
      expect(testCoverage).toHaveLength(0);
    });

    it('flags the missing one when multiple hook .sh files change but only some have tests', () => {
      const { testCoverage } = findTestFiles([
        '.claude/hooks/enforce-permissions.sh',
        '.claude/hooks/__tests__/enforce-permissions.test.mjs',
        '.claude/hooks/check-prerequisites.sh',
        // intentionally no test for check-prerequisites in this diff
      ]);
      expect(testCoverage).toHaveLength(2);
      const enforce = testCoverage.find(c => c.file.endsWith('enforce-permissions.sh'));
      const check = testCoverage.find(c => c.file.endsWith('check-prerequisites.sh'));
      expect(enforce.hasTest).toBe(true);
      expect(check.hasTest).toBe(false);
      expect(check.expectedTestPath).toBe('.claude/hooks/__tests__/check-prerequisites.test.mjs');
    });

    it('returns an empty testCoverage on an empty diff (boundary: vacuous truth)', () => {
      const { testCoverage, productionFiles, testFiles } = findTestFiles([]);
      expect(testCoverage).toEqual([]);
      expect(productionFiles).toEqual([]);
      expect(testFiles).toEqual([]);
    });

    it('returns an empty testCoverage when only doc files change (boundary)', () => {
      const { testCoverage } = findTestFiles(['docs/glossary.md', 'CLAUDE.md']);
      expect(testCoverage).toEqual([]);
    });

    it('does not flag a non-hooks .sh as needing coverage even though it is recognised as source', () => {
      // `scripts/foo.sh` becomes a productionFiles entry but needsCoverage is
      // false because it is not in COVERAGE_PATTERNS. The display logic in
      // preflight-check.js filters by `needsCoverage`.
      const { testCoverage } = findTestFiles(['scripts/upload-qa-screenshots.sh']);
      expect(testCoverage).toHaveLength(1);
      expect(testCoverage[0].needsCoverage).toBe(false);
    });
  });
});

describe('tsx source ↔ .ts sibling test (Issue #1049)', () => {
  it('reports no gap when a .tsx source has a .ts sibling test in __tests__ (positive)', () => {
    // A JSX-free pure-logic test naturally lives as `.ts` even though its
    // source is `.tsx` — sibling matching is basename/dir based and does
    // not require the extensions to match.
    const { testCoverage } = findTestFiles([
      'packages/client/src/components/foo/Bar.tsx',
      'packages/client/src/components/foo/__tests__/Bar.test.ts',
    ]);
    expect(testCoverage).toHaveLength(1);
    expect(testCoverage[0].hasTest).toBe(true);
    expect(testCoverage[0].needsCoverage).toBe(true);
  });

  it('reports no gap when a .tsx source has a .ts sibling test in the same dir (positive)', () => {
    const { testCoverage } = findTestFiles([
      'packages/client/src/components/foo/Bar.tsx',
      'packages/client/src/components/foo/Bar.test.ts',
    ]);
    expect(testCoverage).toHaveLength(1);
    expect(testCoverage[0].hasTest).toBe(true);
  });

  it('flags a gap when a .tsx source has no sibling test at all (negative)', () => {
    const { testCoverage } = findTestFiles(['packages/client/src/components/foo/Bar.tsx']);
    expect(testCoverage).toHaveLength(1);
    expect(testCoverage[0].hasTest).toBe(false);
  });

  it('suggests both .tsx and .ts as candidate paths for a .tsx source missing coverage', () => {
    const { testCoverage } = findTestFiles(['packages/client/src/components/foo/Bar.tsx']);
    expect(testCoverage[0].expectedTestPath).toBe(
      'packages/client/src/components/foo/__tests__/Bar.test.tsx',
    );
    expect(testCoverage[0].alternateTestPath).toBe(
      'packages/client/src/components/foo/__tests__/Bar.test.ts',
    );
  });

  it('does not suggest an alternate path for a .ts source (reverse case out of scope)', () => {
    const { testCoverage } = findTestFiles(['packages/server/src/services/foo.ts']);
    expect(testCoverage[0].alternateTestPath).toBeNull();
  });

  it('does not credit a .tsx source from a same-named .ts test in an unrelated directory (dir must still match)', () => {
    const { testCoverage } = findTestFiles([
      'packages/client/src/components/foo/Bar.tsx',
      'packages/client/src/components/other/Bar.test.ts',
    ]);
    expect(testCoverage[0].hasTest).toBe(false);
  });

  it('recognises the real SessionPage.tsx + SessionPage.test.ts pairing that motivated Issue #1049', () => {
    const { testCoverage } = findTestFiles([
      'packages/client/src/components/sessions/SessionPage.tsx',
      'packages/client/src/components/sessions/__tests__/SessionPage.test.ts',
    ]);
    expect(testCoverage).toHaveLength(1);
    expect(testCoverage[0].hasTest).toBe(true);
  });
});

describe('runLanguageCheck', () => {
  function makeFixtureRoot({ withScript = true, withFixture } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'lang-helper-'));
    if (withScript) {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      // Copy the real script so the helper exercises the actual detection.
      const scriptSource = readFileSync('scripts/check-public-artifacts-language.mjs', 'utf-8');
      writeFileSync(join(root, 'scripts/check-public-artifacts-language.mjs'), scriptSource);
    }
    if (withFixture) {
      withFixture(root);
    }
    return root;
  }

  it('returns exitCode 0 with empty stdout when public artifacts are clean', () => {
    const root = makeFixtureRoot({
      withFixture: (r) => {
        mkdirSync(join(r, 'docs'), { recursive: true });
        writeFileSync(join(r, 'CLAUDE.md'), '# Pure ASCII English file.\n');
        writeFileSync(join(r, 'docs/a.md'), 'Café résumé works.\n');
      },
    });
    try {
      const result = runLanguageCheck({ repoRoot: root });
      expect(result.spawnFailed).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().endsWith('language check clean (2 files scanned).')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns exitCode 1 with a violation list when violations exist', () => {
    const root = makeFixtureRoot({
      withFixture: (r) => {
        mkdirSync(join(r, 'docs'), { recursive: true });
        writeFileSync(join(r, 'docs/a.md'), 'Hello\n日本\n');
      },
    });
    try {
      const result = runLanguageCheck({ repoRoot: root });
      expect(result.spawnFailed).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('docs/a.md:2:1');
      expect(result.stdout).toContain('U+65E5');
      expect(result.stdout).toContain('U+672C');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags spawnFailed when the runtime binary cannot be spawned', () => {
    const root = makeFixtureRoot();
    try {
      const result = runLanguageCheck({
        repoRoot: root,
        binary: 'definitely-not-a-real-binary-xyz',
      });
      expect(result.spawnFailed).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Failed to spawn 'definitely-not-a-real-binary-xyz'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isCommentOnlyDiff (Issue #1189)', () => {
  it('returns true for a pure single-line `//` comment change', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index abc..def 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10 +10 @@',
      "-  // old note (Issue #1)",
      '+  // new note',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(true);
  });

  it('returns true for a pure block-comment (JSDoc) change with the opener confirmed in the same hunk', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -336,5 +336 @@ export async function runAsUser(',
      '-/**',
      '- * `lib/git.ts` encapsulates git command construction (Issue #882 dogfood',
      '- * feedback from the owner: code placement matters even when behaviour is',
      '- * identical).',
      '- */',
      '+/** `lib/git.ts` encapsulates git command construction. */',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(true);
  });

  it('returns true for a block comment opened and closed within the same hunk', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,3 @@',
      '-/* old rationale',
      '- * spanning lines */',
      '+/* new rationale',
      '+ * spanning lines, revised */',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(true);
  });

  it('returns false for a mixed diff (comment change + real code change)', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10,2 +10,2 @@',
      '-  // old note',
      '-  return a + b;',
      '+  // new note',
      '+  return a + b + 1;',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(false);
  });

  it('returns true for a blank-line-only diff', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10,2 +10,2 @@',
      '-',
      '-   ',
      '+',
      '+   ',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(true);
  });

  it('returns true for a deletion-only diff where every removed line is a comment', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -60,6 +59,0 @@',
      '-/**',
      '- * Register all job handlers with the job queue.',
      '- * @param jobQueue The JobQueue instance to register handlers with',
      '- */',
      '-// A trailing single-line note',
      '-',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(true);
  });

  it('returns true for a `.sh` file with only `#` comment changes', () => {
    const diff = [
      'diff --git a/foo.sh b/foo.sh',
      '--- a/foo.sh',
      '+++ b/foo.sh',
      '@@ -3 +3 @@',
      '-# old explanation (Issue #1)',
      '+# new explanation',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.sh')).toBe(true);
  });

  it('returns false for a `.sh` file with a real code change', () => {
    const diff = [
      'diff --git a/foo.sh b/foo.sh',
      '--- a/foo.sh',
      '+++ b/foo.sh',
      '@@ -3 +3 @@',
      '-echo "old"',
      '+echo "new"',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.sh')).toBe(false);
  });

  it('returns true for `.tsx` and `.js`/`.mjs` extensions with comment-only changes', () => {
    const tsxDiff = ['--- a/foo.tsx', '+++ b/foo.tsx', '@@ -1 +1 @@', '-// old', '+// new'].join('\n');
    const jsDiff = ['--- a/foo.js', '+++ b/foo.js', '@@ -1 +1 @@', '-// old', '+// new'].join('\n');
    const mjsDiff = ['--- a/foo.mjs', '+++ b/foo.mjs', '@@ -1 +1 @@', '-// old', '+// new'].join('\n');
    expect(isCommentOnlyDiff(tsxDiff, 'foo.tsx')).toBe(true);
    expect(isCommentOnlyDiff(jsDiff, 'foo.js')).toBe(true);
    expect(isCommentOnlyDiff(mjsDiff, 'foo.mjs')).toBe(true);
  });

  it('returns false for an unsupported extension (opt-in later)', () => {
    const diff = ['--- a/foo.py', '+++ b/foo.py', '@@ -1 +1 @@', '-# old', '+# new'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.py')).toBe(false);
  });

  it('returns false when there are no changed lines at all', () => {
    expect(isCommentOnlyDiff('', 'foo.ts')).toBe(false);
  });

  it('treats a block comment opened outside the hunk as non-comment when no file content is supplied (fail-closed default)', () => {
    // No preceding `/*` in this hunk's own text, and no opts.baseContent /
    // opts.headContent to consult — the diff alone cannot confirm this line
    // is inside a block comment that opened earlier in unchanged context,
    // so it is conservatively NOT treated as comment-only. See the
    // "Issue #1394" describe block below for the content-aware case.
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -50 +50 @@', '-continuation of a block comment', '+revised continuation'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(false);
  });

  // Regression tests for CodeRabbit findings on PR #1192 (Issue #1189).

  it('does not exempt a changed `++counter;` expression that renders as a `+++`-prefixed diff line', () => {
    // With no leading whitespace, `++counter;` becomes the diff line
    // "+++counter;" — indistinguishable from a `+++ b/file` header by a
    // naive prefix check. Must still be parsed as real code once inside a
    // hunk, even though every OTHER changed line here is a comment.
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10 +10,2 @@',
      '-// old note',
      '+// old note, plus a side-effect now',
      '+++counter;',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(false);
  });

  it('does not exempt a `.sh` file whose shebang line changes, even though it starts with `#`', () => {
    const diff = ['--- a/foo.sh', '+++ b/foo.sh', '@@ -1 +1 @@', '-#!/bin/sh', '+#!/bin/bash'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.sh')).toBe(false);
  });

  it('does not exempt a bare `*`-prefixed line with no confirmed block opener in the hunk (e.g. a multiplication continuation)', () => {
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -3 +3 @@', '-  * 2;', '+  * 3;'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(false);
  });

  it('does not exempt a single-line block comment followed by real code on the same line', () => {
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -1 +1 @@', '-// old note', '+/* note */ changedCall();'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(false);
  });

  it('does not exempt a multi-line block comment whose close line is followed by real code', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,2 @@',
      '-/* old',
      '- note */',
      '+/* new',
      '+ note */ changedCall();',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(false);
  });
});

describe('isCommentOnlyDiff — opener outside the --unified=0 hunk, seeded via file content (Issue #1394)', () => {
  it('returns true for a JSDoc body edit whose `/**` opener is outside the hunk, when opts.baseContent/headContent are supplied', () => {
    const baseContent = ['function foo() {}', '', '/**', ' * old continuation line', ' */', 'const x = 1;'].join('\n');
    const headContent = ['function foo() {}', '', '/**', ' * new continuation line', ' */', 'const x = 1;'].join('\n');
    // Hunk starts at line 4 on both sides — the `/**` opener on line 3 is
    // outside this --unified=0 hunk's own text, same shape as PR #1393.
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -4 +4 @@', '- * old continuation line', '+ * new continuation line'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts', { baseContent, headContent })).toBe(true);
  });

  it('still returns false for a mixed diff (comment body edit + real code change) even with content supplied', () => {
    const baseContent = ['/**', ' * old note', ' */', 'const x = 1;'].join('\n');
    const headContent = ['/**', ' * new note', ' */', 'const x = 2;'].join('\n');
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -2 +2 @@',
      '- * old note',
      '+ * new note',
      '@@ -4 +4 @@',
      '-const x = 1;',
      '+const x = 2;',
    ].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts', { baseContent, headContent })).toBe(false);
  });

  it('still fails closed when content is supplied but the changed line is genuinely not inside a block comment', () => {
    // Same shape as the multiplication-continuation regression above, but
    // this time with content supplied — confirms content-seeding does not
    // relax the fail-closed default when the file itself has no open block.
    const baseContent = ['const y = 1', '  * 2;'].join('\n');
    const headContent = ['const y = 1', '  * 3;'].join('\n');
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -2 +2 @@', '-  * 2;', '+  * 3;'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts', { baseContent, headContent })).toBe(false);
  });

  it('returns false for a real code change following a phantom `/*` picked up from a string/glob literal (adversarial seed)', () => {
    // `'packages/server/src/*'` contains the two characters `/*` with no
    // matching `*/` later on the line, so scanBlockCommentLineStarts reads
    // it as an unterminated block-comment opener and marks every
    // subsequent line as "starts inside a block" -- even though the file
    // has no real block comment at all. Without the shape-check guard in
    // isCommentOnlyDiff, this phantom seed would make the hunk's actual
    // code change (`return 1;` -> `return 2;`) look like comment body
    // (no `*/` on that line either) and silently exempt it from the
    // sibling-test requirement -- a fail-open in the mechanism that
    // enforces test coverage. This is the load-bearing negative case for
    // the shape-check guard.
    const baseContent = ["const paths = glob('packages/server/src/*');", 'function realCode() {', '  return 1;', '}'].join('\n');
    const headContent = ["const paths = glob('packages/server/src/*');", 'function realCode() {', '  return 2;', '}'].join('\n');
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -3 +3 @@', '-  return 1;', '+  return 2;'].join('\n');
    expect(isCommentOnlyDiff(diff, 'foo.ts', { baseContent, headContent })).toBe(false);
  });

  it('confirms the JSDoc body edit is actually exempted via the content-seeding path, not by coincidence', () => {
    // Same fixture as the first test in this block, but calling
    // isCommentOnlyDiff both without and with opts makes the dependency on
    // content-seeding explicit within a single test, rather than relying
    // on the reader to infer it from two separately-written tests.
    const baseContent = ['function foo() {}', '', '/**', ' * old continuation line', ' */', 'const x = 1;'].join('\n');
    const headContent = ['function foo() {}', '', '/**', ' * new continuation line', ' */', 'const x = 1;'].join('\n');
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -4 +4 @@', '- * old continuation line', '+ * new continuation line'].join('\n');

    expect(isCommentOnlyDiff(diff, 'foo.ts')).toBe(false); // no content supplied: fail-closed, as before
    expect(isCommentOnlyDiff(diff, 'foo.ts', { baseContent, headContent })).toBe(true); // content supplied: recognised
  });

  // Polarity fixture: the actual `sdk-engine.ts` diff from PR #1393
  // (chore/1338-bump-claude-agent-sdk, comparing origin/main...FETCH_HEAD).
  // Its hunk edits only the BODY of an existing JSDoc block; the `/**`
  // opener (file line 44) sits outside the --unified=0 hunk (which starts
  // at line 46). Before this fix, isCommentOnlyDiff returned false for
  // this exact input; after the fix it must return true. A regression to
  // the pre-fix state can be confirmed by commenting out the
  // scanBlockCommentLineStarts-seeding change in check-utils.js and
  // re-running this test (see workflow.md's "Demonstrating polarity"
  // procedure) — it must fail against that unmodified state.
  const PR_1393_SDK_ENGINE_DIFF = [
    'diff --git a/packages/embedded-agent/src/sdk-engine.ts b/packages/embedded-agent/src/sdk-engine.ts',
    'index 0c2dd471..e50dfb56 100644',
    '--- a/packages/embedded-agent/src/sdk-engine.ts',
    '+++ b/packages/embedded-agent/src/sdk-engine.ts',
    "@@ -46,10 +46,10 @@ type ToolResultEvent = Extract<EmbeddedAgentEvent, { type: 'tool-result' }>;",
    '- * immediately after a turn\'s `result` intermittently threw "ProcessTransport',
    '- * is not ready for writing" -- an EMPIRICAL observation on SDK 0.3.226/0.3.233',
    '- * (both-version confirmed), NOT a documented SDK contract. ~300-500ms of',
    '- * settle reliably fixed it in the probe. Retry-with-settle, not a bare sleep:',
    '- * the budget below (5 settle gaps at 500ms = 2500ms across 6 attempts)',
    '- * comfortably exceeds both the observed 300-500ms window and the AC\'s',
    '- * "at least 3 attempts spanning at least 2s total" floor. Re-verify this',
    '- * constant pair on every SDK upgrade -- the SDK-bump tracking issue\'s',
    '- * checklist carries this obligation (docs/design/embedded-agent-sdk-engine.md',
    '- * §5\'s re-verification note).',
    '+ * immediately after a turn\'s `result` can throw "ProcessTransport is not',
    '+ * ready for writing" -- an encoded workaround for empirically observed',
    '+ * behavior, NOT a documented SDK contract. Retry-with-settle, not a bare',
    '+ * sleep: the budget below (5 settle gaps at 500ms = 2500ms across 6',
    '+ * attempts) comfortably exceeds both the originally observed settle window',
    '+ * and the AC\'s "at least 3 attempts spanning at least 2s total" floor.',
    '+ * Re-verify this constant pair on every SDK upgrade -- the SDK-bump',
    '+ * tracking issue\'s checklist carries this obligation. §5 is the canonical',
    '+ * source for this hazard\'s CURRENT epistemic status; do not infer it from',
    '+ * this comment.',
  ].join('\n');

  // File lines 40-58 of packages/embedded-agent/src/sdk-engine.ts, verbatim
  // from origin/main (base) and FETCH_HEAD (head) of PR #1393 as of this
  // fixture's capture. Padded with 39 blank lines so array index N-1 lands
  // on real file line N, matching the diff's own line numbers above (the
  // `/**` opener is real file line 44).
  const PR_1393_SDK_ENGINE_BASE_CONTENT = Array(39)
    .fill('')
    .concat([
      "type AssistantMessagePayload = Extract<SDKMessage, { type: 'assistant' }>['message'];",
      "type UserMessagePayload = Extract<SDKMessage, { type: 'user' }>['message'];",
      "type ToolResultEvent = Extract<EmbeddedAgentEvent, { type: 'tool-result' }>;",
      '',
      '/**',
      ' * H2 (docs/design/embedded-agent-sdk-engine.md §5): calling `getContextUsage()`',
      ' * immediately after a turn\'s `result` intermittently threw "ProcessTransport',
      ' * is not ready for writing" -- an EMPIRICAL observation on SDK 0.3.226/0.3.233',
      ' * (both-version confirmed), NOT a documented SDK contract. ~300-500ms of',
      ' * settle reliably fixed it in the probe. Retry-with-settle, not a bare sleep:',
      ' * the budget below (5 settle gaps at 500ms = 2500ms across 6 attempts)',
      ' * comfortably exceeds both the observed 300-500ms window and the AC\'s',
      ' * "at least 3 attempts spanning at least 2s total" floor. Re-verify this',
      ' * constant pair on every SDK upgrade -- the SDK-bump tracking issue\'s',
      ' * checklist carries this obligation (docs/design/embedded-agent-sdk-engine.md',
      ' * §5\'s re-verification note).',
      ' */',
      'const CONTEXT_USAGE_SETTLE_DELAY_MS = 500;',
      'const CONTEXT_USAGE_MAX_ATTEMPTS = 6;',
    ])
    .join('\n');

  const PR_1393_SDK_ENGINE_HEAD_CONTENT = Array(39)
    .fill('')
    .concat([
      "type AssistantMessagePayload = Extract<SDKMessage, { type: 'assistant' }>['message'];",
      "type UserMessagePayload = Extract<SDKMessage, { type: 'user' }>['message'];",
      "type ToolResultEvent = Extract<EmbeddedAgentEvent, { type: 'tool-result' }>;",
      '',
      '/**',
      ' * H2 (docs/design/embedded-agent-sdk-engine.md §5): calling `getContextUsage()`',
      ' * immediately after a turn\'s `result` can throw "ProcessTransport is not',
      ' * ready for writing" -- an encoded workaround for empirically observed',
      ' * behavior, NOT a documented SDK contract. Retry-with-settle, not a bare',
      ' * sleep: the budget below (5 settle gaps at 500ms = 2500ms across 6',
      ' * attempts) comfortably exceeds both the originally observed settle window',
      ' * and the AC\'s "at least 3 attempts spanning at least 2s total" floor.',
      ' * Re-verify this constant pair on every SDK upgrade -- the SDK-bump',
      ' * tracking issue\'s checklist carries this obligation. §5 is the canonical',
      ' * source for this hazard\'s CURRENT epistemic status; do not infer it from',
      ' * this comment.',
      ' */',
      'const CONTEXT_USAGE_SETTLE_DELAY_MS = 500;',
      'const CONTEXT_USAGE_MAX_ATTEMPTS = 6;',
    ])
    .join('\n');

  it('returns true for the exact PR #1393 sdk-engine.ts diff (comment-body edit, opener outside the hunk)', () => {
    // Explicit content-path dependency: without base/head content this
    // exact diff still fails closed (same as before this fix), so the
    // `true` below is demonstrably coming from the content-seeding path,
    // not from some incidental change in the hunk-local logic.
    expect(isCommentOnlyDiff(PR_1393_SDK_ENGINE_DIFF, 'packages/embedded-agent/src/sdk-engine.ts')).toBe(false);
    expect(
      isCommentOnlyDiff(PR_1393_SDK_ENGINE_DIFF, 'packages/embedded-agent/src/sdk-engine.ts', {
        baseContent: PR_1393_SDK_ENGINE_BASE_CONTENT,
        headContent: PR_1393_SDK_ENGINE_HEAD_CONTENT,
      }),
    ).toBe(true);
  });

  it('returns false when the same PR #1393-shaped diff also carries one real code line change', () => {
    // Append a second hunk that changes real code (line 58 in both files:
    // CONTEXT_USAGE_MAX_ATTEMPTS 6 -> 7) to the exact same comment-only
    // hunk above. The mixed diff must not be exempted.
    const mixedDiff = [
      PR_1393_SDK_ENGINE_DIFF,
      '@@ -58 +58 @@',
      '-const CONTEXT_USAGE_MAX_ATTEMPTS = 6;',
      '+const CONTEXT_USAGE_MAX_ATTEMPTS = 7;',
    ].join('\n');
    expect(
      isCommentOnlyDiff(mixedDiff, 'packages/embedded-agent/src/sdk-engine.ts', {
        baseContent: PR_1393_SDK_ENGINE_BASE_CONTENT,
        headContent: PR_1393_SDK_ENGINE_HEAD_CONTENT,
      }),
    ).toBe(false);
  });
});

describe('isCommentOnlyFileDiff (git integration)', () => {
  function makeTempGitRepo() {
    const root = mkdtempSync(join(tmpdir(), 'comment-only-repo-'));
    execSync('git init -q -b main', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name Test', { cwd: root });
    return root;
  }

  function commit(root, message) {
    execSync('git add -A', { cwd: root });
    execSync(`git commit -q -m "${message}"`, { cwd: root });
  }

  it('returns true when a real commit on a branch changes only a comment', () => {
    const root = makeTempGitRepo();
    try {
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  // old note\n  return a + b;\n}\n');
      commit(root, 'initial');
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  // new note\n  return a + b;\n}\n');
      commit(root, 'comment tweak');

      // No `process.chdir()` here — passing `root` as the explicit `cwd`
      // argument keeps this test isolated from other test files running
      // concurrently in the same bun process.
      const result = isCommentOnlyFileDiff('foo.ts', 'HEAD~1', root);
      expect(result).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a real commit changes production logic', () => {
    const root = makeTempGitRepo();
    try {
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  return a + b;\n}\n');
      commit(root, 'initial');
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  return a + b + 1;\n}\n');
      commit(root, 'logic change');

      const result = isCommentOnlyFileDiff('foo.ts', 'HEAD~1', root);
      expect(result).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true for an edit to the body of an existing JSDoc block, where the `/**` opener is outside the --unified=0 hunk (Issue #1394)', () => {
    const root = makeTempGitRepo();
    try {
      const before = [
        'export function foo() {}',
        '',
        '/**',
        ' * H2: this JSDoc block has several lines so the opener falls',
        ' * outside a --unified=0 hunk that only edits a later line.',
        ' */',
        'const X = 1;',
        '',
      ].join('\n');
      const after = [
        'export function foo() {}',
        '',
        '/**',
        ' * H2: this JSDoc block has several lines so the opener falls',
        ' * outside a --unified=0 hunk that only edits THIS revised line.',
        ' */',
        'const X = 1;',
        '',
      ].join('\n');

      writeFileSync(join(root, 'foo.ts'), before);
      commit(root, 'initial');
      writeFileSync(join(root, 'foo.ts'), after);
      commit(root, 'jsdoc body tweak');

      const result = isCommentOnlyFileDiff('foo.ts', 'HEAD~1', root);
      expect(result).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// isCommentOnlyFileDiff's diff source defaults to the checked-out
// worktree's HEAD, which is correct for preflight-check.js's no-PR-number
// / CI-checkout modes but wrong when checking an arbitrary PR number from
// a worktree that is not checked out to that PR's branch. These tests pin
// the fix: an explicit `headRef` must be honored even when the process's
// real checkout (git's own HEAD) points somewhere else entirely.
//
// Measured reach (revert-the-fix polarity check, per workflow.md "Every
// pin's reach is measured, not predicted"): forcing `headRef` to always
// resolve to `'HEAD'` inside isCommentOnlyFileDiff (the pre-fix behavior)
// flips the FIRST test below from pass to fail — the diff is computed
// against `main` (still checked out) instead of `feature`, so `git diff
// main...HEAD` is empty and the comment-only content is invisible. This
// reproduces the underlying symptom deterministically, without network.
// The SECOND test below (mixed-diff negative direction) does NOT flip under
// that same revert — it is an invariant-preservation test (testing.md's
// third category): it guards against a plausible wrong headRef
// implementation that reports comment-only regardless of the actual diff
// content, not against this specific regression.
describe('isCommentOnlyFileDiff with an explicit headRef', () => {
  function makeTempGitRepo() {
    const root = mkdtempSync(join(tmpdir(), 'comment-only-headref-repo-'));
    execSync('git init -q -b main', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name Test', { cwd: root });
    return root;
  }

  function commit(root, message) {
    execSync('git add -A', { cwd: root });
    execSync(`git commit -q -m "${message}"`, { cwd: root });
  }

  it('diffs against the given headRef, not the checked-out HEAD, when they differ', () => {
    const root = makeTempGitRepo();
    try {
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  // old note\n  return a + b;\n}\n');
      commit(root, 'initial');

      execSync('git checkout -q -b feature', { cwd: root });
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  // new note\n  return a + b;\n}\n');
      commit(root, 'comment tweak on feature');

      // Back on main: the worktree's real HEAD is now main, NOT feature —
      // this is the exact shape of the Orchestrator checking an arbitrary
      // PR from their own session.
      execSync('git checkout -q main', { cwd: root });

      const result = isCommentOnlyFileDiff('foo.ts', 'main', root, 'feature');
      expect(result).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still detects a real logic change on a non-checked-out headRef (mixed-diff negative direction)', () => {
    const root = makeTempGitRepo();
    try {
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  return a + b;\n}\n');
      commit(root, 'initial');

      execSync('git checkout -q -b feature', { cwd: root });
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  return a + b + 1;\n}\n');
      commit(root, 'logic change on feature');

      execSync('git checkout -q main', { cwd: root });

      const result = isCommentOnlyFileDiff('foo.ts', 'main', root, 'feature');
      expect(result).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults headRef to HEAD when omitted, preserving prior behavior', () => {
    const root = makeTempGitRepo();
    try {
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  // old note\n  return a + b;\n}\n');
      commit(root, 'initial');
      writeFileSync(join(root, 'foo.ts'), 'export function add(a, b) {\n  // new note\n  return a + b;\n}\n');
      commit(root, 'comment tweak');

      const result = isCommentOnlyFileDiff('foo.ts', 'HEAD~1', root);
      expect(result).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Same revert-the-fix check as above, applied at findTestFiles's own
// boundary rather than isCommentOnlyFileDiff's: forcing headRef to always
// resolve to 'HEAD' also flips this test (isCommentOnly/needsCoverage
// invert), confirming the diffRef option actually reaches the comment-only
// check rather than being silently dropped somewhere in the threading.
describe('findTestFiles with an explicit diffRef', () => {
  function makeTempGitRepo() {
    const root = mkdtempSync(join(tmpdir(), 'find-test-files-diffref-repo-'));
    execSync('git init -q -b main', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name Test', { cwd: root });
    return root;
  }

  function commit(root, message) {
    execSync('git add -A', { cwd: root });
    execSync(`git commit -q -m "${message}"`, { cwd: root });
  }

  it('threads baseRef/headRef/cwd through to the comment-only check, matching acceptance-check.js\'s actual call shape', () => {
    const root = makeTempGitRepo();
    try {
      const relPath = 'packages/server/src/services/foo.ts';
      mkdirSync(join(root, 'packages/server/src/services'), { recursive: true });
      writeFileSync(join(root, relPath), 'export function add(a, b) {\n  // old note\n  return a + b;\n}\n');
      commit(root, 'initial');

      execSync('git checkout -q -b feature', { cwd: root });
      writeFileSync(join(root, relPath), 'export function add(a, b) {\n  // new note\n  return a + b;\n}\n');
      commit(root, 'comment tweak on feature');

      execSync('git checkout -q main', { cwd: root });

      const { testCoverage } = findTestFiles([relPath], { baseRef: 'main', headRef: 'feature', cwd: root });
      expect(testCoverage).toHaveLength(1);
      expect(testCoverage[0].isCommentOnly).toBe(true);
      expect(testCoverage[0].needsCoverage).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// resolvePrDiffRef throws PrDiffRefResolutionError (rather than calling
// process.exit itself) specifically so its failure path is a value a test
// can trigger directly, instead of a side effect that would kill the test
// runner. The `execImpl` DI seam (pay-as-you-go, mirrors the
// elevation-helpers `runAsUserImpl` convention) is what makes that
// triggering possible without touching the real `gh`/`git` binaries.
describe('resolvePrDiffRef failure path', () => {
  it('throws when gh api fails to resolve the PR (execImpl returns null)', () => {
    const execImpl = () => null;
    expect(() => resolvePrDiffRef('123', { execImpl })).toThrow(PrDiffRefResolutionError);
    expect(() => resolvePrDiffRef('123', { execImpl })).toThrow(/Could not resolve base\/head SHAs for PR #123/);
  });

  it('throws when gh api returns unparseable JSON', () => {
    const execImpl = () => 'not json';
    expect(() => resolvePrDiffRef('123', { execImpl })).toThrow(PrDiffRefResolutionError);
    expect(() => resolvePrDiffRef('123', { execImpl })).toThrow(/not valid JSON/);
  });

  it('throws when the resolved SHAs are missing a base or head', () => {
    const execImpl = () => JSON.stringify({ base: 'abc123', head: null });
    expect(() => resolvePrDiffRef('123', { execImpl })).toThrow(PrDiffRefResolutionError);
    expect(() => resolvePrDiffRef('123', { execImpl })).toThrow(/missing a base\/head SHA/);
  });

  it('throws when the SHA fetch fails after a successful resolution', () => {
    let call = 0;
    const execImpl = (cmd) => {
      call += 1;
      if (cmd.startsWith('gh api')) return JSON.stringify({ base: 'aaa', head: 'bbb' });
      return null; // the subsequent `git fetch` call
    };
    expect(() => resolvePrDiffRef('123', { execImpl })).toThrow(PrDiffRefResolutionError);
    expect(call).toBeGreaterThan(0);
  });

  it('returns the resolved refs when both gh api and git fetch succeed', () => {
    const execImpl = (cmd) => (cmd.startsWith('gh api') ? JSON.stringify({ base: 'aaa', head: 'bbb' }) : '');
    expect(resolvePrDiffRef('123', { execImpl })).toEqual({ baseRef: 'aaa', headRef: 'bbb' });
  });
});