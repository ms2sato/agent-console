import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEPCRUISE_BIN = resolve(REPO_ROOT, 'node_modules/.bin/depcruise');

// The only files this pin tolerates being absent from the graph. This list
// is DELIBERATELY independent of `.dependency-cruiser.cjs`'s own
// `options.exclude.path` -- an earlier draft derived it from that same
// config, which meant any new entry added there was automatically exempted
// from this pin too, silently reproducing Issue #1487's blind spot (a
// growing exclusion list that nothing double-checks). Reach was measured by
// temporarily adding a second `options.exclude.path` entry and confirming
// THAT draft still passed; requiring a second, independent entry here is
// what makes a future exclusion need a human to justify it twice.
const KNOWN_INTENTIONAL_EXCLUSIONS = new Set([
  // GRANDFATHERED in .dependency-cruiser.cjs: vitest.config.ts exists but
  // the project uses `bun test`, not vitest.
  'packages/server/vitest.config.ts',
]);

function gitLsFiles() {
  const result = spawnSync('git', ['ls-files', 'packages/**/*.ts', 'packages/**/*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}

function cruiseModuleGraph() {
  const result = spawnSync(
    DEPCRUISE_BIN,
    ['--config', '.dependency-cruiser.cjs', '--output-type', 'json', 'packages'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 128 },
  );
  if (!result.stdout) {
    throw new Error(`depcruise produced no output (exit ${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function graphModuleSet(graph) {
  const modules = new Set();
  for (const mod of graph.modules) {
    modules.add(mod.source);
    for (const dep of mod.dependencies) {
      if (dep.resolved) {
        modules.add(dep.resolved);
      }
    }
  }
  return modules;
}

describe('dependency-cruiser graph completeness', () => {
  // Guards against a repeat of Issue #1487: madge's only exclusion
  // primitive silently dropped a file (and nine siblings) as a full graph
  // node, so a real cycle through it went unreported with no indication
  // anything was omitted. dependency-cruiser has no such node-level
  // exclusion path in normal use -- the only sanctioned one is the single,
  // documented, inline-commented entry in `.dependency-cruiser.cjs`'s
  // `options.exclude.path` -- so this pin asserts every OTHER lint-scoped
  // source file resolves into the graph, catching any future exclusion
  // (madge-shaped or not) that tries to reintroduce this blind spot.
  // Cruising ~950 modules across the whole `packages/` tree takes 2.5-3s on
  // a fast machine; bun:test's default 5000ms per-test timeout is too tight
  // on a slower CI runner (observed: 5022ms on GitHub Actions).
  it(
    'includes every lint-scoped TS/TSX source file as a graph node or a resolved dependency target',
    async () => {
      const gitFiles = gitLsFiles().filter((file) => !KNOWN_INTENTIONAL_EXCLUSIONS.has(file));

      const graph = cruiseModuleGraph();
      const moduleSet = graphModuleSet(graph);

      const missing = gitFiles.filter((file) => !moduleSet.has(file));
      expect(missing).toEqual([]);
    },
    30000,
  );
});
