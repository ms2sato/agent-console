#!/usr/bin/env node
// Generates packages/shared/src/schema-version.gen.ts: a build-time constant
// derived from the content of every wire-schema file. The value lets the
// server advertise its schema version (WebSocket first frame + REST header)
// so a client can detect a server/client schema mismatch.
//
// Single source of truth for BOTH the generator and the staleness test:
// the file-set definition (SCHEMAS_DIR + selection rules + the transitive
// runtime-import closure, see `resolveRuntimeImportClosure` below) and the
// hash algorithm live only here. The staleness test invokes this script
// with `--check` rather than re-deriving anything.
//
// Usage:
//   node scripts/generate-schema-version.mjs           write (idempotent) + print version
//   node scripts/generate-schema-version.mjs --check   exit 1 if committed file is stale/missing
//   node scripts/generate-schema-version.mjs --print    print version without writing

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import ts from 'typescript';

import { normalizeSchemaSource } from './schema-source-normalize.mjs';

// Resolve everything relative to this script's location, NOT the caller's cwd,
// so the output is identical regardless of where the script is invoked from.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// The curated wire-schema file set: every `.ts` file directly under this
// directory. `__tests__/` is a subdirectory and is therefore excluded by the
// "directly under" rule. The generated output lives OUTSIDE this directory
// (at packages/shared/src/), so the hash set can never self-reference.
const SCHEMAS_DIR = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'schemas');
const OUTPUT_FILE = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'schema-version.gen.ts');

/**
 * Determine whether an `ImportDeclaration`'s clause represents at least one
 * runtime (value-carrying) binding, as opposed to a purely type-only import
 * that cannot change accepted wire values at runtime.
 *
 * - No clause at all (`import './x.js';`) is a side-effect import: it always
 *   executes the target module, so it counts as runtime.
 * - A whole-declaration `import type { ... } from '...'` (`isTypeOnly` on the
 *   clause itself) never counts, regardless of what it names.
 * - A default binding (`import Foo from '...'`) always counts.
 * - A namespace binding (`import * as ns from '...'`) always counts.
 * - Named bindings (`import { A, type B } from '...'`) count if AT LEAST ONE
 *   named specifier is not itself marked `isTypeOnly` — this is a per-
 *   specifier flag distinct from the whole-declaration flag, so
 *   `import { type A, B } from '...'` still counts (because of `B`) while
 *   `import { type A, type B } from '...'` does not.
 * @param {ts.ImportClause | undefined} importClause
 * @returns {boolean}
 */
function isRuntimeImportClause(importClause) {
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
  if (importClause.name) return true;
  const namedBindings = importClause.namedBindings;
  if (!namedBindings) return true;
  if (ts.isNamespaceImport(namedBindings)) return true;
  if (ts.isNamedImports(namedBindings)) {
    return namedBindings.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

/**
 * Resolve a relative import specifier (written NodeNext-style with a `.js`
 * extension, e.g. `'../types/embedded-agent.js'`) to the absolute path of
 * the `.ts` source file it actually points at on disk.
 * @param {string} fromFile absolute path of the file containing the import
 * @param {string} specifier the raw string literal from the import
 * @returns {string} absolute path, `.ts`-suffixed
 */
function resolveImportSpecifierToFile(fromFile, specifier) {
  const withoutJsExt = specifier.endsWith('.js') ? specifier.slice(0, -'.js'.length) : specifier;
  return path.resolve(path.dirname(fromFile), `${withoutJsExt}.ts`);
}

/**
 * Parse a single file's top-level import declarations and return the
 * absolute paths of every module it runtime-imports via a RELATIVE
 * specifier (package specifiers, i.e. anything not starting with `.`, are
 * out of scope by construction — they live outside `packages/shared/src`).
 * @param {string} file absolute path
 * @returns {string[]} absolute paths, not necessarily deduplicated or sorted
 */
function findRuntimeRelativeImportFiles(file) {
  const content = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const files = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    if (!isRuntimeImportClause(statement.importClause)) continue;
    files.push(resolveImportSpecifierToFile(file, specifier));
  }
  return files;
}

/**
 * Resolve the transitive closure of files that the given schema files
 * runtime-import (directly or indirectly) via relative specifiers, stopping
 * at package specifiers and at files already in `schemaFiles` itself.
 *
 * This exists because a wire schema's accepted vocabulary can be built from
 * a constant that lives outside `packages/shared/src/schemas/` (e.g. a
 * `picklist` sourced from an array constant in `packages/shared/src/types/`).
 * When such a constant changes, the accepted wire values change even though
 * no file directly under `schemas/` was edited — so the closure must be
 * included in the hash input for `SCHEMA_VERSION` to actually track the
 * wire contract, not just the schema directory's own file text.
 * @param {string[]} schemaFiles absolute paths of the base schema file set
 * @returns {string[]} absolute paths of the additional closure files
 *   (excludes `schemaFiles` itself), sorted, deduplicated
 */
export function resolveRuntimeImportClosure(schemaFiles) {
  const included = new Set(schemaFiles.map((file) => path.resolve(file)));
  const closureFiles = [];
  const queue = [...schemaFiles];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const importedFile of findRuntimeRelativeImportFiles(file)) {
      if (included.has(importedFile)) continue;
      included.add(importedFile);
      closureFiles.push(importedFile);
      queue.push(importedFile);
    }
  }
  return closureFiles.sort();
}

/**
 * Collect the wire-schema files (sorted) that participate in the content
 * hash: every `.ts` file directly under `schemasDir`, plus the transitive
 * runtime-import closure of that set (see `resolveRuntimeImportClosure`).
 * @param {string} [schemasDir] defaults to the real wire-schema directory;
 *   overridable for tests exercising `computeVersion` against a scratch
 *   fixture directory.
 * @returns {string[]} absolute file paths, sorted, deduplicated
 */
export function collectSchemaFiles(schemasDir = SCHEMAS_DIR) {
  const baseFiles = readdirSync(schemasDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(schemasDir, name));
  const closureFiles = resolveRuntimeImportClosure(baseFiles);
  return [...baseFiles, ...closureFiles].sort();
}

/**
 * Compute the schema version: sha256 over the concatenation of
 * `<relative-path>\n<normalized-file-content>` for each file returned by
 * `collectSchemaFiles` — the curated `schemas/*.ts` set plus its transitive
 * runtime-import closure — first 16 hex chars.
 *
 * Each file's content is normalized via `normalizeSchemaSource` before
 * hashing, so comment-only and whitespace-only edits do not change the
 * version (see scripts/schema-source-normalize.mjs). If a file fails to
 * parse, normalization is skipped for that file and its raw, unmodified
 * bytes are hashed instead — a fail-closed fallback: the worst case is an
 * unnecessary version bump, never a silently-skipped semantic change.
 * @param {string} [schemasDir] see `collectSchemaFiles`.
 * @returns {string}
 */
export function computeVersion(schemasDir = SCHEMAS_DIR) {
  const hash = createHash('sha256');
  for (const file of collectSchemaFiles(schemasDir)) {
    const relPath = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const content = readFileSync(file, 'utf8');
    let hashedContent;
    try {
      hashedContent = normalizeSchemaSource(content);
    } catch {
      hashedContent = content;
    }
    hash.update(`${relPath}\n${hashedContent}`);
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Render the exact content of the generated module for a given version.
 * @param {string} version
 * @param {number} fileCount the number of files `collectSchemaFiles()`
 *   returned to produce `version` — surfaced in the header comment so a
 *   reader can see the closure rule's current effect without re-deriving it.
 * @returns {string}
 */
function renderOutput(version, fileCount) {
  return `// AUTO-GENERATED by scripts/generate-schema-version.mjs — do not edit manually.
// Content hash over packages/shared/src/schemas/*.ts plus its transitive
// runtime-import closure (${fileCount} files as of generation; see
// resolveRuntimeImportClosure in scripts/generate-schema-version.mjs).
export const SCHEMA_VERSION = '${version}';
`;
}

/**
 * @returns {string | null} the current committed file content, or null if absent.
 */
function readCommitted() {
  try {
    return readFileSync(OUTPUT_FILE, 'utf8');
  } catch {
    return null;
  }
}

/**
 * CLI entry point. Not invoked on import — only when this module is run
 * directly (`node scripts/generate-schema-version.mjs ...`) — so tests can
 * import `computeVersion` / `collectSchemaFiles` without triggering a write
 * to OUTPUT_FILE as a side effect.
 */
function main() {
  const args = new Set(process.argv.slice(2));
  const version = computeVersion();
  const fileCount = collectSchemaFiles().length;
  const expected = renderOutput(version, fileCount);

  if (args.has('--check')) {
    const committed = readCommitted();
    if (committed !== expected) {
      console.error(
        `schema-version.gen.ts is stale. Run: node scripts/generate-schema-version.mjs`,
      );
      process.exit(1);
    }
    console.log(version);
    process.exit(0);
  }

  if (args.has('--print')) {
    console.log(version);
    process.exit(0);
  }

  // Write mode: idempotent (skip the write when the content is unchanged).
  if (readCommitted() !== expected) {
    writeFileSync(OUTPUT_FILE, expected);
  }
  console.log(version);
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('generate-schema-version.mjs');
if (isMainModule) {
  main();
}
