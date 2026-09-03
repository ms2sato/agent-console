import { describe, it, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion, collectSchemaFiles } from '../generate-schema-version.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GENERATOR = resolve(REPO_ROOT, 'scripts', 'generate-schema-version.mjs');
const REAL_SCHEMAS_DIR = join(REPO_ROOT, 'packages', 'shared', 'src', 'schemas');

const tempDirs = [];

/** Create a real temp directory containing the given `{name: content}` files. */
function makeSchemasFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'schema-version-normalize-test-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/**
 * Create a scratch directory containing sibling `schemas/` and `types/`
 * subdirectories, mirroring packages/shared/src's real layout, so a
 * relative specifier like `'../types/y.js'` written from a file inside the
 * scratch `schemas/` dir resolves into the scratch `types/` dir — exercising
 * `resolveRuntimeImportClosure`'s directory-relative resolution the same
 * way it works against the real tree.
 * @param {Record<string, string>} files keyed by path relative to the
 *   scratch root, e.g. `'schemas/a.ts'` / `'types/y.ts'`.
 * @returns {string} the scratch `schemas/` directory (pass to
 *   `collectSchemaFiles`/`computeVersion` the same way the real
 *   `SCHEMAS_DIR` default is used).
 */
function makeSiblingFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'schema-version-closure-test-'));
  tempDirs.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(root, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return join(root, 'schemas');
}

/**
 * repo-relative-ish path, just the last two segments, for readable
 * assertions. Splits on the platform path separator (`node:path`'s `sep`),
 * not a hardcoded `'/'` — `collectSchemaFiles()` returns OS-native paths, so
 * on Windows a literal `'/'` split would return the whole path unsplit and
 * silently break every assertion built from this helper.
 */
function lastTwoSegments(absPath) {
  return absPath.split(sep).slice(-2).join('/');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('generate-schema-version.mjs — computeVersion end-to-end (temp fixtures)', () => {
  // computeVersion() hashes each file's *relative path* alongside its
  // content, so the "before" and "after" variants of a row must live at the
  // same directory (same relative path) — otherwise the path component
  // alone would make the hashes differ regardless of content. Both variants
  // below therefore write into the SAME temp directory, overwriting the
  // fixture file in place between the two computeVersion() calls.

  // Row 1: pure comment diff -> SAME version.
  it('produces the same version when only a comment is added to a fixture file', () => {
    const dir = makeSchemasFixture({
      'a.ts': 'export const Schema = { foo: 1 };\n',
    });
    const before = computeVersion(dir);

    writeFileSync(
      join(dir, 'a.ts'),
      '// docstring fix, no behavior change\nexport const Schema = { foo: 1 };\n',
    );
    const after = computeVersion(dir);

    expect(after).toBe(before);
  });

  // Row 2: pure code diff -> DIFFERENT version.
  it('produces a different version when the actual field value changes', () => {
    const dir = makeSchemasFixture({
      'a.ts': 'export const Schema = { foo: 1 };\n',
    });
    const before = computeVersion(dir);

    writeFileSync(join(dir, 'a.ts'), 'export const Schema = { foo: 2 };\n');
    const after = computeVersion(dir);

    expect(after).not.toBe(before);
  });

  it('is deterministic across repeated calls against the same fixture directory', () => {
    const dir = makeSchemasFixture({
      'a.ts': 'export const Schema = { foo: 1 };\n',
      'b.ts': '// comment\nexport const Other = 2;\n',
    });
    expect(computeVersion(dir)).toBe(computeVersion(dir));
  });

  it('falls back to raw-byte hashing for a file that fails to parse', () => {
    const brokenSource = "const x = {{{ ) ( unterminated string = 'abc\n";
    const dir = makeSchemasFixture({ 'broken.ts': brokenSource });
    // Two runs against the identical broken fixture must still agree (the
    // fallback path is itself deterministic), proving the fail-closed
    // branch does not crash computeVersion or behave non-deterministically.
    expect(computeVersion(dir)).toBe(computeVersion(dir));
  });
});

describe('generate-schema-version.mjs — CLI --print wiring against the real schemas dir', () => {
  it('runs end-to-end via the CLI and matches the exported computeVersion() for the real schemas', () => {
    const result = spawnSync('bun', [GENERATOR, '--print'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(computeVersion());
  });
});

describe('generate-schema-version.mjs — runtime-import closure resolution (scratch sibling fixtures)', () => {
  it('follows a runtime relative import one level into a sibling types/ file', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "import { X } from '../types/y.js';\nexport const Schema = X;\n",
      'types/y.ts': 'export const X = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).toContain('types/y.ts');
  });

  it('follows a runtime relative import transitively, two levels deep', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "import { X } from '../types/y.js';\nexport const Schema = X;\n",
      'types/y.ts': "import { Z } from './z.js';\nexport const X = Z;\n",
      'types/z.ts': 'export const Z = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).toContain('types/y.ts');
    expect(files).toContain('types/z.ts');
  });

  it('ignores a whole-declaration `import type` and does not include the target file', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "import type { X } from '../types/y.js';\nexport const Schema = 1;\n",
      'types/y.ts': 'export const X = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).not.toContain('types/y.ts');
  });

  it('ignores a package specifier and never attempts to resolve it', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "import { X } from 'some-package';\nexport const Schema = X;\n",
    });

    // Must not throw attempting to resolve a non-relative specifier as a file,
    // and must not include anything beyond the one base schema file.
    const files = collectSchemaFiles(schemasDir);

    expect(files.length).toBe(1);
    expect(files[0].endsWith('schemas/a.ts')).toBe(true);
  });

  it('deduplicates a file reachable from two schema files', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "import { X } from '../types/y.js';\nexport const SchemaA = X;\n",
      'schemas/b.ts': "import { X } from '../types/y.js';\nexport const SchemaB = X;\n",
      'types/y.ts': 'export const X = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir);
    const yOccurrences = files.filter((f) => f.endsWith('types/y.ts'));

    expect(yOccurrences.length).toBe(1);
  });

  it('includes a module when at least one named specifier is not type-only', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "import { type A, B } from '../types/y.js';\nexport const Schema = B;\n",
      'types/y.ts': 'export type A = string;\nexport const B = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).toContain('types/y.ts');
  });

  it('excludes a module when every named specifier is type-only', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts':
        "import { type A, type B } from '../types/y.js';\nexport const Schema = 1;\n",
      'types/y.ts': 'export type A = string;\nexport type B = number;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).not.toContain('types/y.ts');
  });

  it('follows a relative named re-export one level into a sibling types/ file', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "export { X } from '../types/y.js';\n",
      'types/y.ts': 'export const X = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).toContain('types/y.ts');
  });

  it('follows a relative named re-export transitively, two levels deep', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "export { X } from '../types/y.js';\n",
      'types/y.ts': "export { Z as X } from './z.js';\n",
      'types/z.ts': 'export const Z = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).toContain('types/y.ts');
    expect(files).toContain('types/z.ts');
  });

  it('follows a wildcard `export *` re-export', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "export * from '../types/y.js';\n",
      'types/y.ts': 'export const X = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).toContain('types/y.ts');
  });

  it('ignores a whole-declaration `export type ... from` and does not include the target file', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "export type { X } from '../types/y.js';\n",
      'types/y.ts': 'export type X = string;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).not.toContain('types/y.ts');
  });

  it('includes a re-exported module when at least one named specifier is not type-only', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "export { type A, B } from '../types/y.js';\n",
      'types/y.ts': 'export type A = string;\nexport const B = 1;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).toContain('types/y.ts');
  });

  it('excludes a re-exported module when every named specifier is type-only', () => {
    const schemasDir = makeSiblingFixture({
      'schemas/a.ts': "export { type A, type B } from '../types/y.js';\n",
      'types/y.ts': 'export type A = string;\nexport type B = number;\n',
    });

    const files = collectSchemaFiles(schemasDir).map(lastTwoSegments);

    expect(files).not.toContain('types/y.ts');
  });
});

describe('generate-schema-version.mjs — real-tree closure tell (a picklist source outside schemas/)', () => {
  // These pin the actual defect the closure was built to catch: a schema
  // file's accepted wire vocabulary sourced from a constant that lives in
  // packages/shared/src/types/, outside the hashed schemas/ directory. The
  // measurement runs the real generator against the real file tree, via a
  // temporary, synchronously restored perturbation — same mutate/probe/
  // restore shape as packages/shared/src/__tests__/schema-version.gen.test.ts's
  // existing embedded-agent.ts sensitivity tests.

  it('changes SCHEMA_VERSION when PTY_NOTIFICATION_KINDS (types/system-events.ts) is perturbed', () => {
    // PTY_NOTIFICATION_KINDS backs a runtime `import { PTY_NOTIFICATION_KINDS }`
    // in packages/shared/src/schemas/embedded-agent.ts (a picklist source),
    // so it is inside the closure and must move the version.
    const targetFile = join(REPO_ROOT, 'packages', 'shared', 'src', 'types', 'system-events.ts');
    const original = readFileSync(targetFile, 'utf8');
    const baseline = computeVersion();

    let mutated;
    try {
      const perturbed = original.replace(
        'export const PTY_NOTIFICATION_KINDS = [',
        "export const PTY_NOTIFICATION_KINDS = [\n  '__schema_version_closure_probe__',",
      );
      // Sanity: the replace actually matched something in the real file.
      expect(perturbed).not.toBe(original);
      writeFileSync(targetFile, perturbed);
      mutated = computeVersion();
    } finally {
      writeFileSync(targetFile, original);
    }

    expect(mutated).not.toBe(baseline);
    // Restoring the file yields the original version again (no residue).
    expect(computeVersion()).toBe(baseline);
  });

  it('does NOT change SCHEMA_VERSION when a type-only-reachable file (types/worker.ts) is perturbed', () => {
    // Negative control, same shape, on the real tree: packages/shared/src/types/worker.ts
    // is reachable from packages/shared/src/schemas/embedded-agent.ts ONLY via
    // `import type { ExitReason } from '../types/worker.js';` — a whole-declaration
    // type-only import — so it must stay outside the closure even though it
    // sits right beside the two files that ARE in it.
    const targetFile = join(REPO_ROOT, 'packages', 'shared', 'src', 'types', 'worker.ts');
    const original = readFileSync(targetFile, 'utf8');
    const baseline = computeVersion();

    let mutated;
    try {
      const perturbed = original.replace(
        "export type ExitReason = 'managed' | 'unexpected' | 'evicted';",
        "export type ExitReason = 'managed' | 'unexpected' | 'evicted' | '__schema_version_closure_probe__';",
      );
      // Sanity: the replace actually matched something in the real file.
      expect(perturbed).not.toBe(original);
      writeFileSync(targetFile, perturbed);
      mutated = computeVersion();
    } finally {
      writeFileSync(targetFile, original);
    }

    expect(mutated).toBe(baseline);
    expect(computeVersion()).toBe(baseline);
  });
});

describe('generate-schema-version.mjs — invariant pin: every real runtime relative import/re-export lands in collectSchemaFiles()', () => {
  // Independent, regex-based second pass over the real schemas/*.ts files —
  // deliberately NOT a call into resolveRuntimeImportClosure, so this test
  // can actually detect a regression in that resolver rather than merely
  // agreeing with itself by construction. All of this repo's schema files
  // write their imports/exports as single, unwrapped lines (confirmed by
  // reading every file in packages/shared/src/schemas/), so a per-line
  // regex is sufficient here even though it would not be a general-purpose
  // parser.
  const IMPORT_LINE = /^import\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+'(\.[^']+)';?\s*$/;
  // Mirrors IMPORT_LINE for the export-from shape. The named-elements group
  // is optional-braced (`{[^}]*}`) or a bare wildcard, optionally aliased
  // (`* as ns`) — `export * from '...'` has no clause at all.
  const EXPORT_LINE =
    /^export\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s+from\s+'(\.[^']+)';?\s*$/;

  function grepRuntimeRelativeImportSpecifiers(file) {
    const content = readFileSync(file, 'utf8');
    const specifiers = [];
    for (const line of content.split('\n')) {
      const match = line.match(IMPORT_LINE);
      if (!match) continue;
      const [, wholeTypeOnly, clause, specifier] = match;
      if (wholeTypeOnly) continue;
      if (clause.startsWith('{')) {
        const elements = clause
          .slice(1, -1)
          .split(',')
          .map((el) => el.trim())
          .filter(Boolean);
        const hasRuntimeElement = elements.some((el) => !el.startsWith('type '));
        if (!hasRuntimeElement) continue;
      }
      specifiers.push(specifier);
    }
    return specifiers;
  }

  /**
   * Same shape as `grepRuntimeRelativeImportSpecifiers`, for `export ... from`
   * lines instead of `import ... from` lines. Exported separately (rather
   * than folded into the import scanner) so a test can exercise it directly
   * against a synthetic string — see the non-vacuousness self-check below,
   * which exists because, as of writing, no real schema file uses this
   * pattern and the real-tree loop below therefore never calls this on a
   * matching line.
   * @param {string} content raw file content (not a file path — callers
   *   reading a real file pass its content; the self-check passes a literal)
   */
  function grepRuntimeRelativeExportSpecifiersFromContent(content) {
    const specifiers = [];
    for (const line of content.split('\n')) {
      const match = line.match(EXPORT_LINE);
      if (!match) continue;
      const [, wholeTypeOnly, clause, specifier] = match;
      if (wholeTypeOnly) continue;
      if (clause.startsWith('{')) {
        const elements = clause
          .slice(1, -1)
          .split(',')
          .map((el) => el.trim())
          .filter(Boolean);
        const hasRuntimeElement = elements.some((el) => !el.startsWith('type '));
        if (!hasRuntimeElement) continue;
      }
      specifiers.push(specifier);
    }
    return specifiers;
  }

  function grepRuntimeRelativeExportSpecifiers(file) {
    return grepRuntimeRelativeExportSpecifiersFromContent(readFileSync(file, 'utf8'));
  }

  function grepResolveSpecifier(fromFile, specifier) {
    const withoutJsExt = specifier.endsWith('.js') ? specifier.slice(0, -'.js'.length) : specifier;
    return resolve(dirname(fromFile), `${withoutJsExt}.ts`);
  }

  it('resolves every runtime relative import/re-export found by an independent scan into the collected file set', () => {
    const collected = new Set(collectSchemaFiles());
    const realSchemaFiles = readdirSync(REAL_SCHEMAS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(REAL_SCHEMAS_DIR, entry.name));

    // Guard against the scan itself going vacuous (e.g. a future refactor
    // wraps every import in braces across multiple lines and the regex
    // silently stops matching anything).
    let totalRuntimeRelativeImports = 0;
    // Companion counter for the export-from half. As of writing this is
    // expected to stay 0 against the real tree (confirmed via
    // `grep -n "^export.*from '\.\./\|^export \* from '\.\./"
    // packages/shared/src/schemas/*.ts` returning no matches) — no real
    // schema file currently relative-re-exports anything. That is a fact
    // about today's tree, not about this scan's ability to detect the
    // pattern: the self-check test below exercises
    // `grepRuntimeRelativeExportSpecifiersFromContent` directly against a
    // synthetic re-export line, so a future regression in the export-side
    // regex is still caught even while this counter reads 0 here.
    let totalRuntimeRelativeReExports = 0;

    for (const file of realSchemaFiles) {
      for (const specifier of grepRuntimeRelativeImportSpecifiers(file)) {
        totalRuntimeRelativeImports += 1;
        const resolved = grepResolveSpecifier(file, specifier);
        expect(collected.has(resolved)).toBe(true);
      }
      for (const specifier of grepRuntimeRelativeExportSpecifiers(file)) {
        totalRuntimeRelativeReExports += 1;
        const resolved = grepResolveSpecifier(file, specifier);
        expect(collected.has(resolved)).toBe(true);
      }
    }

    expect(totalRuntimeRelativeImports).toBeGreaterThan(0);
    // See the comment above: 0 is the currently-expected, observed value.
    expect(totalRuntimeRelativeReExports).toBe(0);
  });

  it('non-vacuousness self-check: the export-side scanner still detects a runtime re-export line', () => {
    // Exercises grepRuntimeRelativeExportSpecifiersFromContent directly
    // against a synthetic line, independent of the real tree, so this scan
    // half stays provably alive even though the real-tree loop above never
    // feeds it a matching line today.
    const specifiers = grepRuntimeRelativeExportSpecifiersFromContent(
      "export { X } from '../types/y.js';\n",
    );
    expect(specifiers).toEqual(['../types/y.js']);
  });
});
