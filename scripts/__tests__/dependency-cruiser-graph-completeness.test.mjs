import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEPCRUISE_BIN = resolve(REPO_ROOT, 'node_modules/.bin/depcruise');
const SUBPROCESS_TIMEOUT_MS = 30000;

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

// spawnSync blocks Node's event loop for the life of the child process, so
// bun:test's per-test timeout (the `it(..., 30000)` argument below) cannot
// interrupt a hung child -- it can only fire once control returns to the
// loop, which a blocked spawnSync never yields. The subprocess-level
// `timeout` option is the only thing that can actually bound a hang; a
// timed-out or signal-killed child must be treated as a hard failure of its
// own, distinct from "produced no/bad output".
function runOrThrow(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 128,
  });
  if (result.error) {
    throw new Error(`${cmd} failed to spawn or was killed: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(
      `${cmd} was terminated by signal ${result.signal} (likely a ${SUBPROCESS_TIMEOUT_MS}ms timeout)`,
    );
  }
  return result;
}

function gitLsFiles() {
  const result = runOrThrow('git', ['ls-files', 'packages/**/*.ts', 'packages/**/*.tsx']);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}

function cruiseModuleGraph() {
  const result = runOrThrow(DEPCRUISE_BIN, [
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'json',
    'packages',
  ]);
  if (!result.stdout) {
    throw new Error(`depcruise produced no output (exit ${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

// Membership is built ONLY from `graph.modules[].source` -- the set of files
// dependency-cruiser actually visited and analyzed as nodes. An earlier
// draft also added every `dependencies[].resolved` path, on the reasoning
// that a file referenced by an importer must exist; that conflates "some
// module's import specifier resolved to this path" with "dependency-cruiser
// analyzed this path as a module", which are different claims -- the whole
// point of this pin is to verify the second one, not the first. Measured
// directly against this repo's pinned dependency-cruiser@17.3.10 (four
// scenarios: a bare JS pair, a JS pair with a real rule set, this project's
// full graph with a heavily-imported file excluded, and a synthetic
// type-only-only edge to an excluded file): `options.exclude.path` drops the
// edge from the importer's `dependencies` array entirely, so `resolved`
// never actually retains an excluded path in this codebase's usage today.
// The simplification is kept anyway -- it is the more directly correct
// definition of "in the graph", and it removes a dependency on that
// specific (and not distro/version-guaranteed) tool behavior rather than
// relying on it.
function graphModuleSet(graph) {
  return new Set(graph.modules.map((mod) => mod.source));
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
    'includes every lint-scoped TS/TSX source file as a graph node',
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
