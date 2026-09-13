import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_VIOLATIONS,
  SANCTIONED_LOCATIONS,
  findMockModuleCallsInSource,
  findDefaultFiles,
  formatStaleEntry,
  formatViolation,
  isSanctionedLocation,
  runCheck,
} from '../check-mock-module-poisoners.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/check-mock-module-poisoners.mjs');

describe('findMockModuleCallsInSource — AST detection', () => {
  it('detects a real mock.module(...) call with a string-literal specifier', () => {
    const source = `import { mock } from 'bun:test';\nmock.module('../foo.js', () => ({}));\n`;
    const calls = findMockModuleCallsInSource(source, 'x.ts');
    expect(calls).toEqual([{ line: 2, col: 1, specifier: '../foo.js' }]);
  });

  it('reports line/col of the mock.module( token itself, not the whole statement', () => {
    const source = `const x = 1;\n  mock.module('a', () => ({}));\n`;
    const calls = findMockModuleCallsInSource(source, 'x.ts');
    expect(calls).toHaveLength(1);
    expect(calls[0].line).toBe(2);
    expect(calls[0].col).toBe(3);
  });

  it('ignores a mock.module( mention inside a // line comment', () => {
    const source = `// never call mock.module('x') per Anti-Pattern #2\nconst y = 1;\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([]);
  });

  it('ignores a mock.module( mention inside a /* */ block comment', () => {
    const source = `/*\n * see mock.module('x') for why this is prohibited\n */\nconst y = 1;\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([]);
  });

  it('ignores a string literal containing the text "mock.module("', () => {
    const source = `const msg = "never write mock.module(' in this file";\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([]);
  });

  it('reports a non-string-literal (dynamic) first argument as <dynamic>', () => {
    const source = `const target = getTarget();\nmock.module(target, () => ({}));\n`;
    const calls = findMockModuleCallsInSource(source, 'x.ts');
    expect(calls).toEqual([{ line: 2, col: 1, specifier: '<dynamic>' }]);
  });

  it('does not flag an unrelated mock(...) call or a module.exports assignment', () => {
    const source = `const fn = mock(() => {});\nmodule.exports = {};\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([]);
  });

  it('does not flag a property-access call named module on a non-mock identifier', () => {
    const source = `something.module('x', () => ({}));\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([]);
  });

  it('detects the bracket-notation form mock[\'module\'](...)', () => {
    const source = `mock['module']('x', () => ({}));\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([
      { line: 1, col: 1, specifier: 'x' },
    ]);
  });

  it('detects a parenthesized callee form (mock).module(...)', () => {
    const source = `(mock).module('x', () => ({}));\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([
      { line: 1, col: 1, specifier: 'x' },
    ]);
  });

  it('detects the other parenthesized form (mock.module)(...)', () => {
    const source = `(mock.module)('x', () => ({}));\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([
      { line: 1, col: 1, specifier: 'x' },
    ]);
  });

  it('detects the template-literal bracket form mock[`module`](...)', () => {
    const source = 'mock[`module`](\'x\', () => ({}));\n';
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([
      { line: 1, col: 1, specifier: 'x' },
    ]);
  });

  it('does not flag bracket access with a non-"module" property name', () => {
    const source = `mock['moduleFactory']('x', () => ({}));\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([]);
  });

  it('does not flag bracket access with a dynamic (non-literal) property name', () => {
    const source = `const prop = 'module';\nmock[prop]('x', () => ({}));\n`;
    expect(findMockModuleCallsInSource(source, 'x.ts')).toEqual([]);
  });

  it('detects a call inside a .tsx file (JSX-aware parse)', () => {
    const source = `import { mock } from 'bun:test';\nconst el = <div />;\nmock.module('x', () => ({}));\n`;
    const calls = findMockModuleCallsInSource(source, 'x.tsx');
    expect(calls).toEqual([{ line: 3, col: 1, specifier: 'x' }]);
  });

  it('detects multiple calls in the same file', () => {
    const source = `mock.module('a', () => ({}));\nmock.module('b', () => ({}));\n`;
    const calls = findMockModuleCallsInSource(source, 'x.ts');
    expect(calls.map((c) => c.specifier)).toEqual(['a', 'b']);
  });
});

describe('isSanctionedLocation', () => {
  it('exempts the exact central registry file', () => {
    expect(isSanctionedLocation('packages/server/src/__tests__/test-utils.ts')).toBe(true);
  });

  it('exempts any file under the central registry directory', () => {
    expect(
      isSanctionedLocation('packages/server/src/__tests__/utils/mock-open-helper.ts'),
    ).toBe(true);
  });

  it('does not exempt an unrelated __tests__ file', () => {
    expect(isSanctionedLocation('packages/server/src/__tests__/api.test.ts')).toBe(false);
  });

  it('does not exempt a similarly-named file outside the registry', () => {
    expect(isSanctionedLocation('packages/server/src/__tests__/test-utils2.ts')).toBe(false);
  });
});

describe('formatViolation / formatStaleEntry', () => {
  it('formats a violation with file:line:col, specifier, and the rule cross-link', () => {
    const text = formatViolation({ file: 'a/b.ts', line: 3, col: 5, specifier: 'x' });
    expect(text).toBe(
      "a/b.ts:3:5 mock.module('x') — module-level mock outside the central mock registry; see .claude/rules/testing.md Anti-Pattern #2",
    );
  });

  it('formats a stale entry with the "stale allowlist entry" marker', () => {
    const text = formatStaleEntry({ file: 'a/b.ts', specifier: 'x' });
    expect(text).toContain('stale allowlist entry — remove it in this PR');
  });
});

describe('runCheck — allowlist and sanctioned-location behaviour', () => {
  function makeFixture() {
    const root = mkdtempSync(join(tmpdir(), 'mock-module-lint-'));
    mkdirSync(join(root, 'packages/server/src/__tests__/utils'), { recursive: true });
    return root;
  }

  it('a call inside a sanctioned location produces no violation', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/__tests__/test-utils.ts'),
        `mock.module('open', () => ({}));\n`,
      );
      const result = await runCheck({ cwd: root, allowlist: [] });
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an allowlisted file+specifier pair is not a new violation', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.test.ts'),
        `mock.module('bar', () => ({}));\n`,
      );
      const allowlist = [{ file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'baseline' }];
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.violations).toHaveLength(1);
      expect(result.allowlisted).toHaveLength(1);
      expect(result.newViolations).toEqual([]);
      expect(result.staleEntries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the same specifier in a DIFFERENT file is not covered by the allowlist entry', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.test.ts'),
        `mock.module('bar', () => ({}));\n`,
      );
      writeFileSync(
        join(root, 'packages/server/src/other.test.ts'),
        `mock.module('bar', () => ({}));\n`,
      );
      const allowlist = [{ file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'baseline' }];
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.newViolations).toHaveLength(1);
      expect(result.newViolations[0].file).toBe('packages/server/src/other.test.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an allowlist entry with no matching call is reported as stale', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'packages/server/src/foo.test.ts'), `const x = 1;\n`);
      const allowlist = [
        { file: 'packages/server/src/foo.test.ts', specifier: 'gone', reason: 'converted already' },
      ];
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.newViolations).toEqual([]);
      expect(result.staleEntries).toEqual(allowlist);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an unallowlisted call as a new violation', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.test.ts'),
        `mock.module('bar', () => ({}));\n`,
      );
      const result = await runCheck({ cwd: root, allowlist: [] });
      expect(result.newViolations).toHaveLength(1);
      expect(result.newViolations[0]).toMatchObject({
        file: 'packages/server/src/foo.test.ts',
        specifier: 'bar',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cardinality: a single allowlist entry does NOT authorize a second occurrence of the same (file, specifier)', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.test.ts'),
        `mock.module('bar', () => ({}));\nmock.module('bar', () => ({}));\n`,
      );
      const allowlist = [{ file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'baseline' }];
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.allowlisted).toHaveLength(1);
      expect(result.newViolations).toHaveLength(1);
      expect(result.staleEntries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cardinality: two allowlist entries for the same (file, specifier) authorize two occurrences', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.test.ts'),
        `mock.module('bar', () => ({}));\nmock.module('bar', () => ({}));\n`,
      );
      const allowlist = [
        { file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'first' },
        { file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'second' },
      ];
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.allowlisted).toHaveLength(2);
      expect(result.newViolations).toEqual([]);
      expect(result.staleEntries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cardinality: an unused second entry for a single-occurrence key is reported as stale', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.test.ts'),
        `mock.module('bar', () => ({}));\n`,
      );
      const allowlist = [
        { file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'first' },
        { file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'second' },
      ];
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.allowlisted).toHaveLength(1);
      expect(result.newViolations).toEqual([]);
      expect(result.staleEntries).toEqual([{ file: 'packages/server/src/foo.test.ts', specifier: 'bar', reason: 'second' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findDefaultFiles — scan glob', () => {
  it('returns only .ts/.tsx files under packages/*/src/**, no CLI args needed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mock-module-lint-default-'));
    try {
      mkdirSync(join(root, 'packages/a/src/sub'), { recursive: true });
      writeFileSync(join(root, 'packages/a/src/x.ts'), '');
      writeFileSync(join(root, 'packages/a/src/sub/y.tsx'), '');
      // Not scanned: wrong extension, or outside packages/*/src/
      writeFileSync(join(root, 'packages/a/src/z.js'), '');
      writeFileSync(join(root, 'packages/a/other.ts'), '');
      const files = await findDefaultFiles({ cwd: root });
      expect(files).toEqual(['packages/a/src/sub/y.tsx', 'packages/a/src/x.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('KNOWN_VIOLATIONS / SANCTIONED_LOCATIONS — baseline integrity', () => {
  it('every KNOWN_VIOLATIONS entry (if any) has a file, specifier, and one-line reason', () => {
    // The original 8-entry baseline was fully converted in Issue #1238;
    // the array is expected to be empty until a new justified exception is
    // added (see the file-exclusive exception in testing.md Anti-Pattern #2).
    expect(KNOWN_VIOLATIONS.length).toBeGreaterThanOrEqual(0);
    for (const entry of KNOWN_VIOLATIONS) {
      expect(typeof entry.file).toBe('string');
      expect(typeof entry.specifier).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('no KNOWN_VIOLATIONS entry targets a sanctioned location (that would be dead weight)', () => {
    for (const entry of KNOWN_VIOLATIONS) {
      expect(isSanctionedLocation(entry.file)).toBe(false);
    }
  });

  it('SANCTIONED_LOCATIONS names the central mock registry', () => {
    expect(SANCTIONED_LOCATIONS).toContain('packages/server/src/__tests__/test-utils.ts');
    expect(SANCTIONED_LOCATIONS).toContain('packages/server/src/__tests__/utils/');
  });

  it(
    'whole-repo self-check: running the detector against the live tree with the baked baseline exits 0',
    () => {
      const result = spawnSync('bun', [SCRIPT_PATH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        // Cap the subprocess so a hang in the detector does not block the
        // whole test run for the full bun-test default timeout.
        timeout: 30_000,
      });
      expect(result.stdout).toContain('Found 0 new violations and 0 stale allowlist entries');
      expect(result.status).toBe(0);
    },
    // The subprocess above is allowed up to 30s, but bun:test's own
    // per-test timeout defaults to 5s regardless -- the enclosing test
    // needs its own timeout override to actually honor that budget,
    // otherwise a whole-repo scan that legitimately takes >5s (this scan's
    // cost grows with total repo size, not with any defect) fails the test
    // wrapper before the subprocess itself ever times out.
    30_000,
  );
});
