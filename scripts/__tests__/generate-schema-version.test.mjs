import { describe, it, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion } from '../generate-schema-version.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GENERATOR = resolve(REPO_ROOT, 'scripts', 'generate-schema-version.mjs');

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
