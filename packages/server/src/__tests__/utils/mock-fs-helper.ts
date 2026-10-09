/**
 * Centralized fs module mock for tests using memfs.
 *
 * IMPORTANT: Import this module in test files that need fs mocking.
 * The mock.module calls are executed once when this module is imported.
 *
 * @example
 * ```typescript
 * import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
 *
 * beforeEach(() => {
 *   setupMemfs({
 *     '/test/config/repositories.json': JSON.stringify([]),
 *   });
 * });
 *
 * afterEach(() => {
 *   cleanupMemfs();
 * });
 * ```
 */
import { vol, fs } from 'memfs';
import { mock } from 'bun:test';

// Register mocks once at module load time.
//
// Each factory returns the namespace object AND a `default` property
// carrying the same object. memfs's `fs` / `fs.promises` have no `default`
// export of their own, but a dependency deep in a route module's import
// graph (`open` -> `is-wsl` / `is-docker` / `is-inside-container`) does
// `import fs from 'node:fs'`, an ESM default import. Once this mock is
// installed, evaluating that dependency for the first time throws
// `SyntaxError: Missing 'default' export in module 'node:fs'` unless the
// mocked module shape carries a `default`. Do not simplify this back to
// `() => fs` -- that reintroduces the missing-default shape.
mock.module('fs', () => ({ ...fs, default: fs }));
mock.module('node:fs', () => ({ ...fs, default: fs }));
mock.module('fs/promises', () => ({ ...fs.promises, default: fs.promises }));
mock.module('node:fs/promises', () => ({ ...fs.promises, default: fs.promises }));

/**
 * Session/worktree directory literals used as `locationPath` in test
 * fixtures across the suite. cwd must exist since #1892; these are the
 * literals the suites use (re-derived via grep against the current tree,
 * not guessed). Seeded before the caller's own `files` in `setupMemfs` so
 * a caller that deliberately gives one of these a different shape (e.g.
 * makes it a file instead of a directory) still wins.
 */
export const FIXTURE_SESSION_DIRS: readonly string[] = [
  '/test/path',
  '/some/path',
  '/tmp/quick',
  '/test/sender-path',
  '/path/to/worktree',
  '/test/worktree',
  '/test/quick',
  '/path/1',
  '/path/to/project',
  '/test/sender-worktree',
  '/test/path2',
  '/path/to/quick',
  '/test/quick-cwd',
  '/test/path-a',
  '/test/path-b',
  '/test/embedded-path',
  // Found via scoped `bun test` runs (Issue #1892 fixup), not in the
  // original enumeration: session-manager.test.ts and sibling files use
  // these as `locationPath` fixtures too.
  '/test/shared-path',
  '/path/2',
  '/test/path1',
  // Found via a full run of session-manager.test.ts (Issue #1892 fixup,
  // round 2): these literals are used as `locationPath` fixtures by tests
  // that don't go through the elevated branch (confirmed by reading each
  // failing stack trace -- all hit user-mode.ts's non-elevated fs.stat/ENOENT
  // path, line 97, not the elevated runAsUser branch at line 86).
  '/test/active',
  '/test/terminal',
  '/path/with spaces/project',
  '/test/live-path',
  '/test/paused-path',
  // Found via a full monorepo `bun run test` run (Issue #1892 fixup,
  // round 3): literals used by worker-lifecycle-manager.test.ts,
  // mcp-server.test.ts, session-ownership.test.ts, and
  // worker-manager-env.test.ts. All confirmed (grepped) to never appear in
  // any `existsSync(...).toBe(false)` absence assertion elsewhere in the
  // suite -- in particular `/test/repo` is also used by
  // repository-manager.test.ts's `toBe(false)` assertions, but those target
  // DIFFERENT derived paths (`${TEST_CONFIG_DIR}/repositories/test-org/repo`,
  // `${TEST_CONFIG_DIR}/repositories/repo/outputs`), never `/test/repo`
  // itself -- no collision.
  '/test/project',
  '/test/dir',
  '/test/repo',
  '/test/repo/worktrees/wt-auth',
  '/test/target-path',
  '/test/parent',
  '/test/worktree/path',
  // Found by running session-ownership.test.ts after the round-3 literals
  // above still left it failing: session-ownership.test.ts and
  // session-manager.test.ts both use this as a child session's
  // `locationPath` in parent/child createdBy-inheritance fixtures. Grepped
  // for `'/test/child'` against `toBe(false)` absence assertions
  // elsewhere -- no hits.
  '/test/child',
];

/**
 * Sets up memfs with the given file structure.
 * Call this in beforeEach before any fs operations.
 *
 * A `null` value creates an empty DIRECTORY at that path (memfs
 * `fromJSON` semantics) -- e.g. `{ '/test/config': null }` for a trusted
 * root that `ensureTrustedDirChain` verifies but never creates.
 */
export function setupMemfs(files: Record<string, string | null> = {}): void {
  // Reset volume
  vol.reset();

  // cwd must exist since #1892: seed the known fixture-literal directories
  // first, so any test that uses one of these strings as a `locationPath`
  // (without itself creating the directory) still passes the real
  // assertSpawnCwdExists check. Spread order matters: a caller's own
  // `files` entry for the same key wins.
  const dirDefaults = Object.fromEntries(FIXTURE_SESSION_DIRS.map((p) => [p, null]));

  // Create directory structure from files
  vol.fromJSON({ ...dirDefaults, ...files }, '/');
}

/**
 * Cleans up memfs after tests.
 * Call this in afterEach.
 */
export function cleanupMemfs(): void {
  vol.reset();
  delete process.env.AGENT_CONSOLE_HOME;
}

/**
 * Creates a standard test config directory structure.
 * Sets AGENT_CONSOLE_HOME environment variable.
 *
 * @param configPath - Path for the config directory (default: '/test/config')
 * @param initialData - Optional initial data for config files
 */
export function setupTestConfigDir(
  configPath = '/test/config',
  initialData: {
    repositories?: unknown[];
    sessions?: unknown[];
    agents?: unknown[];
  } = {}
): void {
  const files: Record<string, string> = {};

  // Ensure config directory exists by creating a placeholder
  // memfs creates parent directories automatically when creating files

  if (initialData.repositories !== undefined) {
    files[`${configPath}/repositories.json`] = JSON.stringify(initialData.repositories);
  }
  if (initialData.sessions !== undefined) {
    files[`${configPath}/sessions.json`] = JSON.stringify(initialData.sessions);
  }
  if (initialData.agents !== undefined) {
    files[`${configPath}/agents.json`] = JSON.stringify(initialData.agents);
  }

  // If no initial data, create an empty file to ensure directory exists
  if (Object.keys(files).length === 0) {
    files[`${configPath}/.keep`] = '';
  }

  setupMemfs(files);
  process.env.AGENT_CONSOLE_HOME = configPath;
}

/**
 * Cleans up test config directory and restores environment.
 */
export function cleanupTestConfigDir(): void {
  cleanupMemfs();
}

/**
 * Gets the current test config directory path.
 * @returns The AGENT_CONSOLE_HOME path set by setupTestConfigDir
 */
export function getTestConfigDir(): string {
  return process.env.AGENT_CONSOLE_HOME || '/test/config';
}

/**
 * Creates a mock git repository structure.
 *
 * @param repoPath - Path for the repository
 * @param options - Repository options
 * @returns Files object for use with setupMemfs
 */
export function createMockGitRepoFiles(
  repoPath: string,
  options: {
    withWorktrees?: string[];
    withBranches?: string[];
  } = {}
): Record<string, string> {
  const files: Record<string, string> = {
    [`${repoPath}/.git/HEAD`]: 'ref: refs/heads/main',
    [`${repoPath}/.git/config`]: '',
    [`${repoPath}/.git/refs/heads/main`]: 'abc123',
  };

  // Add branches
  if (options.withBranches) {
    for (const branch of options.withBranches) {
      files[`${repoPath}/.git/refs/heads/${branch}`] = 'def456';
    }
  }

  // Add worktrees
  if (options.withWorktrees) {
    for (const wtPath of options.withWorktrees) {
      const wtName = wtPath.split('/').pop();
      files[`${wtPath}/.git`] = `gitdir: ${repoPath}/.git/worktrees/${wtName}`;
    }
  }

  return files;
}

