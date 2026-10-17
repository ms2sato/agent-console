import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeVersion, copySchemaClosureTo } from '../../../../scripts/generate-schema-version.mjs';
import { SCHEMA_VERSION } from '../schema-version.gen.js';

// Repo root relative to this test file: packages/shared/src/__tests__ -> up 4.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-schema-version.mjs');

// The generator hashes every `.ts` file directly under this directory.
const SCHEMAS_DIR = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'schemas');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Layout-preserving temp copy of the hashed file set; the real tree is never written. */
function makeClosureCopy() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-version-gen-test-'));
  tempDirs.push(dest);
  return copySchemaClosureTo(dest);
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
    // perturbing a temp copy of the hashed file set (in-process, via the
    // generator's computeVersion) and observing the hash change, then
    // restoring the copy. The real tree is never written. Versions are compared
    // copy-vs-copy only (the hash includes the path relative to the repo root);
    // the committed constant is guarded by the --check tests above.
    //
    // The perturbation must be non-comment content: the generator normalizes
    // comments out of the hash input (see scripts/schema-source-normalize.mjs),
    // so a bare appended comment would no longer move the version — that is
    // the intended behavior this test must not contradict. A harmless
    // top-level export exercises the "the file's actual code participates in
    // the hash" property instead.
    const copy = makeClosureCopy();
    const schemaFile = path.join(copy.schemasDir, 'embedded-agent.ts');
    const original = fs.readFileSync(schemaFile);

    const baseline = computeVersion(copy.schemasDir);

    fs.writeFileSync(
      schemaFile,
      Buffer.concat([
        original,
        Buffer.from('\nexport const __schemaVersionSensitivityProbe = 1;\n'),
      ]),
    );
    const mutated = computeVersion(copy.schemasDir);

    // A change inside the hashed set must move the version.
    expect(mutated).not.toBe(baseline);
    // Restoring the file yields the original version again (no residue).
    fs.writeFileSync(schemaFile, original);
    expect(computeVersion(copy.schemasDir)).toBe(baseline);
  });

  it('is NOT sensitive to a comment-only perturbation of embedded-agent.ts', () => {
    // The complement of the test above: appending a bare comment must NOT
    // change the version, proving the normalization documented in
    // scripts/schema-source-normalize.mjs is actually wired into
    // computeVersion() end-to-end against a copy of a real schema file.
    const copy = makeClosureCopy();
    const schemaFile = path.join(copy.schemasDir, 'embedded-agent.ts');
    const original = fs.readFileSync(schemaFile);

    const baseline = computeVersion(copy.schemasDir);

    fs.writeFileSync(
      schemaFile,
      Buffer.concat([original, Buffer.from('\n// schema-version sensitivity probe\n')]),
    );
    const mutated = computeVersion(copy.schemasDir);

    expect(mutated).toBe(baseline);
    fs.writeFileSync(schemaFile, original);
    expect(computeVersion(copy.schemasDir)).toBe(baseline);
  });
});
