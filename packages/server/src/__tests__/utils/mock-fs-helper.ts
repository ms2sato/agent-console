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

// Register mocks once at module load time
mock.module('fs', () => fs);
mock.module('node:fs', () => fs);
mock.module('fs/promises', () => fs.promises);
mock.module('node:fs/promises', () => fs.promises);

/**
 * Sets up memfs with the given file structure.
 * Call this in beforeEach before any fs operations.
 */
export function setupMemfs(files: Record<string, string> = {}): void {
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

