/**
 * Grep-based invariants for the session-data-path refactor.
 * See docs/design/session-data-path.md §"Call-site coverage (grep-based invariants)".
 *
 * These tests scan production source to detect regressions to the old
 * silent-fallback pattern:
 *   - `new SessionDataPathResolver()` without a baseDir (only the new single-arg constructor exists)
 *   - `repositoryName` field in job-payload literals (new payloads use `{scope, slug}`)
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SERVER_SRC = path.resolve(__dirname, '..');

function walkFiles(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Exclude test directories from this scan.
      if (entry.name === '__tests__') continue;
      // Exclude node_modules just in case.
      if (entry.name === 'node_modules') continue;
      walkFiles(fullPath, acc);
    } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
      // Skip the invariant test itself and the path-resolver source (it defines
      // the constructor).
      if (fullPath === __filename) continue;
      acc.push(fullPath);
    }
  }
  return acc;
}

describe('session-data-path invariants (grep-based)', () => {
  const files = walkFiles(SERVER_SRC);

  it('no production file constructs SessionDataPathResolver without a baseDir argument', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    const pattern = /new\s+SessionDataPathResolver\s*\(\s*\)/g;

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      if (!pattern.test(content)) {
        pattern.lastIndex = 0;
        continue;
      }
      pattern.lastIndex = 0;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          offenders.push({ file, line: i + 1, text: lines[i].trim() });
        }
        pattern.lastIndex = 0;
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no production file writes a repositoryName field into a cleanup job payload', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    // Match `repositoryName:` as an object literal key.
    const pattern = /repositoryName\s*:/;

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          offenders.push({ file, line: i + 1, text: lines[i].trim() });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
