import { describe, it, expect } from 'bun:test';
import * as path from 'path';
import { SCHEMA_VERSION } from '../schema-version.gen.js';

// Repo root relative to this test file: packages/shared/src/__tests__ -> up 4.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-schema-version.mjs');

describe('SCHEMA_VERSION', () => {
  it('is a 16-char lowercase hex string', () => {
    expect(SCHEMA_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is not stale: the committed schema-version.gen.ts matches the schema files', () => {
    // Delegates to the generator's --check mode (single source of truth for the
    // file-set and hash algorithm). Exit 1 means a schema file was edited
    // without regenerating; the developer must run the generator.
    const result = Bun.spawnSync(['bun', GENERATOR, '--check'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('the generator --check prints the same version that is committed', () => {
    const result = Bun.spawnSync(['bun', GENERATOR, '--check'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new TextDecoder().decode(result.stdout).trim();
    expect(stdout).toBe(SCHEMA_VERSION);
  });
});
