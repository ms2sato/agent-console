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

  // Create directory structure from files
  vol.fromJSON(files, '/');
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

