/**
 * Static sweep (Ruling 1, docs/design/agent-surface.md "Model &
 * Reasoning-Effort Parameters"): the `{{model` / `{{effort` template-var
 * scan pattern must have exactly ONE writer --
 * `getAgentParameterCapabilities` in `../agent-parameter-capabilities.ts`.
 * If another file re-implements the same string match, capability
 * detection has drifted into a second, ad-hoc writer -- precisely what
 * Ruling 1 forbids.
 *
 * Positive control first (workflow.md "Cheap refutation" / sub-pattern 9):
 * the sweep must actually find the accessor's own hits before an
 * "elsewhere: zero" result can be trusted as a fact about the codebase
 * rather than a fact about a broken query.
 *
 * Exclusions (kept to the minimum, each independently justified -- see
 * inline comments below):
 *  - any path containing `__tests__` (test fixtures legitimately construct
 *    commandTemplate strings containing `{{model...}}` as test DATA)
 *  - `agent-parameter-capabilities.ts` itself (the positive control)
 *  - `services/agents/claude-code.ts` (the built-in agent's real template)
 *  - `lib/template.ts` (template-engine doc comments, predates this Issue)
 *  - `mcp/mcp-server.ts` (a pinned tool-description string, Issue #1281)
 */
import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import path from 'node:path';
import fs from 'node:fs';

const ACCESSOR_RELATIVE_PATH = 'packages/shared/src/types/agent-parameter-capabilities.ts';

const SCAN_GLOBS = [
  'packages/shared/src/**/*.ts',
  'packages/shared/src/**/*.tsx',
  'packages/server/src/**/*.ts',
  'packages/server/src/**/*.tsx',
  'packages/client/src/**/*.ts',
  'packages/client/src/**/*.tsx',
];

const PATTERNS = ['{{model', '{{effort'];

/**
 * Explicit, justified exclusion list. Each entry is a repo-relative path
 * that legitimately contains one of PATTERNS for a reason that is NOT "this
 * file re-implements agent-parameter capability scanning".
 */
const JUSTIFIED_EXCLUSIONS: Record<string, string> = {
  'packages/server/src/services/agents/claude-code.ts':
    "the built-in Claude Code agent's actual commandTemplate string, which " +
    'legitimately contains {{model:+--model}} as functional template syntax ' +
    '-- this is the DATA getAgentParameterCapabilities is designed to scan, ' +
    'not a second implementation of the scanning logic.',
  'packages/server/src/lib/template.ts':
    'doc comments in the generic template-expansion engine illustrating the ' +
    '{{var:+prefix}} syntax using "model" as an example variable name; ' +
    'predates this Issue and documents the template engine itself, not ' +
    'agent-parameter capability detection.',
  'packages/server/src/mcp/mcp-server.ts':
    "the templateVars tool-parameter's human-readable description quotes " +
    'the {{model:+--model}} placeholder syntax as pinned documentation ' +
    "(Issue #1281, mcp-server.test.ts asserts the literal substring) -- " +
    'prose documentation, not re-implemented scanning logic.',
};

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { workspaces?: unknown };
      if (pkg.workspaces) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate repo root (with workspaces package.json) from ${startDir}`);
}

async function scanFiles(repoRoot: string): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of SCAN_GLOBS) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
      files.add(file);
    }
  }
  return [...files].sort();
}

interface Hit {
  file: string;
  pattern: string;
}

function scanFileForPatterns(absPath: string, relPath: string): Hit[] {
  const content = fs.readFileSync(absPath, 'utf8');
  const hits: Hit[] = [];
  for (const pattern of PATTERNS) {
    if (content.includes(pattern)) {
      hits.push({ file: relPath, pattern });
    }
  }
  return hits;
}

describe('agent-parameter-capabilities: single-writer static sweep', () => {
  it('positive control: the accessor module itself contains both {{model and {{effort patterns', () => {
    const repoRoot = findRepoRoot(import.meta.dir);
    const absPath = path.join(repoRoot, ACCESSOR_RELATIVE_PATH);
    const hits = scanFileForPatterns(absPath, ACCESSOR_RELATIVE_PATH);
    const patternsFound = hits.map((h) => h.pattern);
    // Proves the search mechanism itself works -- an empty "elsewhere: zero"
    // result below is only meaningful once this passes.
    expect(patternsFound).toContain('{{model');
    expect(patternsFound).toContain('{{effort');
  });

  it('finds zero {{model / {{effort occurrences anywhere else in shared/server/client src (excluding tests and justified exclusions)', async () => {
    const repoRoot = findRepoRoot(import.meta.dir);
    const files = await scanFiles(repoRoot);

    const scannedNonExcluded: string[] = [];
    const allHits: Hit[] = [];

    for (const relPath of files) {
      if (relPath.includes('__tests__')) continue;
      if (relPath === ACCESSOR_RELATIVE_PATH) continue;
      if (relPath in JUSTIFIED_EXCLUSIONS) continue;

      scannedNonExcluded.push(relPath);
      const absPath = path.join(repoRoot, relPath);
      allHits.push(...scanFileForPatterns(absPath, relPath));
    }

    // Sanity: the sweep actually scanned a non-trivial number of files (not
    // an accidentally-empty glob result masquerading as "zero elsewhere").
    expect(scannedNonExcluded.length).toBeGreaterThan(100);

    if (allHits.length > 0) {
      const summary = allHits.map((h) => `${h.file} (${h.pattern})`).join('\n');
      throw new Error(
        `Found ${allHits.length} unexpected {{model / {{effort occurrence(s) outside the ` +
          `single-writer accessor module. Either the accessor should be reused instead, or (if ` +
          `this is legitimate prose/data, not re-implemented scanning logic) add a justified ` +
          `entry to JUSTIFIED_EXCLUSIONS:\n${summary}`,
      );
    }
  });

  it('every JUSTIFIED_EXCLUSIONS entry still exists and still contains the pattern it was excluded for (no stale exclusions)', () => {
    const repoRoot = findRepoRoot(import.meta.dir);
    for (const [relPath] of Object.entries(JUSTIFIED_EXCLUSIONS)) {
      const absPath = path.join(repoRoot, relPath);
      expect(fs.existsSync(absPath)).toBe(true);
      const hits = scanFileForPatterns(absPath, relPath);
      expect(hits.length).toBeGreaterThan(0);
    }
  });
});
