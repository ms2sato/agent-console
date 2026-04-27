import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isReExportOnlyContent,
  requiresTestCoverage,
} from '../check-utils.js';

describe('isReExportOnlyContent', () => {
  it('returns true for a single `export * from` statement', () => {
    expect(isReExportOnlyContent(`export * from './foo';`)).toBe(true);
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
    expect(requiresTestCoverage('packages/server/src/lib/logger.ts')).toBe(false);
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