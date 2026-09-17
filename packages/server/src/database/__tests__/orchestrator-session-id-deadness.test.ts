import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * `orchestrator_session_id` (the v40 single-session column on
 * `repositories`) is DEAD since migration v41 (Issue #1716): the
 * repository's designated-Orchestrator set now lives in
 * `repository_orchestrator_sessions`. The column stays physically present
 * -- SQLite's `ALTER TABLE ... DROP COLUMN` refuses to drop a column that
 * participates in a foreign key -- but it must never be read or written by
 * application code again. Only the migration chain that created it
 * (`migrateToV40`) and the migration that backfills-then-clears it
 * (`migrateToV41`), plus its own `schema.ts` type declaration, may
 * reference the substring. A new reader/writer of it anywhere else in
 * `packages/server/src` is a regression of the storage move this Issue
 * made -- this test is the mechanical grep that catches it.
 *
 * Uses `Bun.file()` / `Bun.Glob` rather than `node:fs` deliberately: when
 * this file runs as part of the full server suite, `node:fs` /
 * `node:fs/promises` are process-globally swapped for an in-memory `memfs`
 * volume the moment any sibling test file imports `mock-fs-helper.ts` (see
 * `createDatabaseForTest`'s own comment in `database/connection.ts` for the
 * same rationale) -- a grep over the real source tree would then either
 * read nothing or throw ENOENT, not "run correctly against the wrong
 * files". Bun's native file APIs are not routed through the mockable `fs`
 * module specifier, so they see the real filesystem regardless of what
 * other test files in the same process have done.
 */

// `packages/server/src`, resolved from this file's own location
// (`packages/server/src/database/__tests__/`) rather than hardcoded, so the
// test does not silently pass/fail if the package is ever relocated.
const SRC_ROOT = path.resolve(import.meta.dir, '../..');
const TARGET = 'orchestrator_session_id';

async function walkTsFiles(): Promise<string[]> {
  const glob = new Bun.Glob('**/*.ts');
  const files: string[] = [];
  for await (const relativePath of glob.scan({ cwd: SRC_ROOT, dot: false })) {
    // POSIX-style relative path regardless of host OS path separator.
    const posixPath = relativePath.split(path.sep).join('/');
    if (posixPath.split('/').includes('__tests__')) continue;
    files.push(posixPath);
  }
  return files;
}

async function findMatchingFiles(): Promise<string[]> {
  const matches: string[] = [];
  for (const relativePath of await walkTsFiles()) {
    const content = await Bun.file(path.join(SRC_ROOT, relativePath)).text();
    if (content.includes(TARGET)) {
      matches.push(relativePath);
    }
  }
  return matches.sort();
}

/**
 * Locate the `[startLine, endLine]` (inclusive, 0-indexed) range "owned" by
 * an `export async function <fnName>(` declaration in `connection.ts`: the
 * range ends at the next line that is exactly `}` (the function's own
 * closing brace, at column 0 per this file's formatting convention) or,
 * failing that, the next `export async function` declaration -- whichever
 * comes first.
 *
 * The range STARTS at the declaration line's own leading JSDoc block, not
 * the declaration line itself, when one is directly attached (its closing
 * comment-terminator line immediately precedes the declaration, with no
 * blank line between -- this file's own convention for every migration
 * function, see e.g. migrateToV38). A migration's rationale doc comment
 * legitimately references the column it touches by name; only code OUTSIDE
 * any migration function's declaration-plus-doc-comment is a genuine new
 * reader/writer this test needs to catch.
 */
function findFunctionBodyRange(lines: string[], fnName: string): [number, number] {
  const startMarker = `export async function ${fnName}(`;
  const declIndex = lines.findIndex((line) => line.includes(startMarker));
  if (declIndex === -1) {
    throw new Error(`Could not locate "${startMarker}" in connection.ts`);
  }

  let startIndex = declIndex;
  if (lines[declIndex - 1]?.trim() === '*/') {
    let i = declIndex - 1;
    while (i >= 0 && lines[i].trim() !== '/**') {
      i--;
    }
    if (i >= 0) startIndex = i;
  }

  for (let i = declIndex + 1; i < lines.length; i++) {
    if (lines[i] === '}' || lines[i].startsWith('export async function')) {
      return [startIndex, i];
    }
  }

  // Reached EOF without a closing marker -- treat the rest of the file as
  // the body rather than throwing, so a trailing function is still covered.
  return [startIndex, lines.length - 1];
}

describe('orchestrator_session_id deadness (Issue #1716)', () => {
  // Positive control: without this, a bug in the walk/grep (e.g. a wrong
  // root path) could make `findMatchingFiles()` vacuously return `[]`,
  // which would make the "exactly these two files" assertion below pass
  // for the wrong reason.
  // reach: deleting the `orchestrator_session_id` doc comment from schema.ts
  // (or renaming the column there) fails this test.
  it('positive control: the substring is present in schema.ts', async () => {
    const schemaContent = await Bun.file(path.join(SRC_ROOT, 'database/schema.ts')).text();
    expect(schemaContent.includes(TARGET)).toBe(true);
  });

  // reach: adding a new read/write of `orchestrator_session_id` anywhere in
  // packages/server/src outside connection.ts / schema.ts (e.g.
  // reintroducing it in mappers.ts or a repository) fails this test.
  it('is referenced by exactly database/connection.ts and database/schema.ts', async () => {
    expect(await findMatchingFiles()).toEqual(['database/connection.ts', 'database/schema.ts']);
  });

  // reach: adding a stray reference to `orchestrator_session_id` in
  // connection.ts OUTSIDE migrateToV40 / migrateToV41 (and their leading
  // doc comments) fails this test.
  it('every reference in connection.ts lies inside migrateToV40 or migrateToV41', async () => {
    const connectionPath = path.join(SRC_ROOT, 'database/connection.ts');
    const lines = (await Bun.file(connectionPath).text()).split('\n');

    const [v40Start, v40End] = findFunctionBodyRange(lines, 'migrateToV40');
    const [v41Start, v41End] = findFunctionBodyRange(lines, 'migrateToV41');

    const offendingLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(TARGET)) continue;
      const insideV40 = i >= v40Start && i <= v40End;
      const insideV41 = i >= v41Start && i <= v41End;
      if (!insideV40 && !insideV41) {
        offendingLines.push(i + 1); // 1-indexed for a readable failure message
      }
    }

    expect(offendingLines).toEqual([]);
  });
});
