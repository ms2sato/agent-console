import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_VERSION } from '../schema-version.gen.js';

// Repo root relative to this test file: packages/shared/src/__tests__ -> up 4.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-schema-version.mjs');

// The generator hashes every `.ts` file directly under this directory.
const SCHEMAS_DIR = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'schemas');

/** Run the generator in --print mode (no writes) and return the emitted version. */
function printVersion(): string {
  const result = Bun.spawnSync(['bun', GENERATOR, '--print'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return new TextDecoder().decode(result.stdout).trim();
}

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

  it('includes embedded-agent.ts in the hashed wire-schema file set', () => {
    // The embedded-agent schema module is a `.ts` file directly under the
    // schemas dir, so the generator's "every .ts directly under" rule collects
    // it into the content hash. This is why adding it regenerated the constant.
    const names = fs
      .readdirSync(SCHEMAS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => e.name);
    expect(names).toContain('embedded-agent.ts');
  });

  it('is sensitive to embedded-agent.ts content (the file participates in the hash)', () => {
    // Prove the committed version actually depends on embedded-agent.ts by
    // perturbing it and observing the hash change, then restoring. The entire
    // mutate -> probe -> restore sequence is synchronous (writeFileSync +
    // spawnSync), so no other test can observe the transient edit and the
    // finally block restores the exact original bytes.
    const schemaFile = path.join(SCHEMAS_DIR, 'embedded-agent.ts');
    const original = fs.readFileSync(schemaFile);

    const baseline = printVersion();
    expect(baseline).toBe(SCHEMA_VERSION);

    let mutated: string;
    try {
      fs.writeFileSync(
        schemaFile,
        Buffer.concat([original, Buffer.from('\n// schema-version sensitivity probe\n')]),
      );
      mutated = printVersion();
    } finally {
      fs.writeFileSync(schemaFile, original);
    }

    // A change inside the hashed set must move the version.
    expect(mutated).not.toBe(baseline);
    // Restoring the file yields the original version again (no residue).
    expect(printVersion()).toBe(baseline);
  });
});
