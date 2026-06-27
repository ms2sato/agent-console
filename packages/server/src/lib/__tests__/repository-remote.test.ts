import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Repository } from '@agent-console/shared';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';

// Import after the shared git mock is registered (via mock-git-helper import)
const { withRepositoryRemote } = await import('../repository-remote.js');

function createTestRepository(overrides?: Partial<Repository>): Repository {
  return {
    id: 'repo-1',
    name: 'test-repo',
    path: '/tmp/test-repo',
    createdAt: '2024-01-01T00:00:00Z',
    description: null,
    defaultAgentId: null,
    clonedSourceRepoPath: null,
    ...overrides,
  };
}

describe('withRepositoryRemote', () => {
  beforeEach(() => {
    resetGitMocks();
  });

  it('should enrich repository with remoteUrl from git remote', async () => {
    mockGit.getRemoteUrl.mockResolvedValueOnce('https://github.com/test/repo.git');
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    expect(enriched.remoteUrl).toBe('https://github.com/test/repo.git');
    expect(enriched.id).toBe('repo-1');
    expect(enriched.name).toBe('test-repo');
    expect(enriched.path).toBe('/tmp/test-repo');
    expect(enriched.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('should set remoteUrl to undefined when no remote exists', async () => {
    mockGit.getRemoteUrl.mockResolvedValueOnce(null);
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    expect(enriched.remoteUrl).toBeUndefined();
  });

  it('should not mutate the original repository object', async () => {
    mockGit.getRemoteUrl.mockResolvedValueOnce('https://github.com/test/repo.git');
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    expect(enriched).not.toBe(repo);
    expect(repo.remoteUrl).toBeUndefined();
    expect(enriched.remoteUrl).toBe('https://github.com/test/repo.git');
  });

  it('should preserve all existing repository fields', async () => {
    mockGit.getRemoteUrl.mockResolvedValueOnce('https://github.com/test/repo.git');
    const repo = createTestRepository({
      description: 'A test repo',
      setupCommand: 'bun install',
      cleanupCommand: 'rm -rf node_modules',
      envVars: 'FOO=bar',
      defaultAgentId: 'agent-1',
    });
    const enriched = await withRepositoryRemote(repo);

    expect(enriched.description).toBe('A test repo');
    expect(enriched.setupCommand).toBe('bun install');
    expect(enriched.cleanupCommand).toBe('rm -rf node_modules');
    expect(enriched.envVars).toBe('FOO=bar');
    expect(enriched.defaultAgentId).toBe('agent-1');
  });

  // ===========================================================================
  // Issue #905: clonedSourceRepoPath derivation from getSourceReposDir()
  // ===========================================================================

  describe('clonedSourceRepoPath derivation (Issue #905)', () => {
    let originalSourceReposDir: string | undefined;

    beforeEach(() => {
      originalSourceReposDir = process.env.AGENT_CONSOLE_SOURCE_REPOS_DIR;
      // Pin the source-repos dir to a deterministic value independent of any
      // ambient AGENT_CONSOLE_HOME so tests do not depend on the developer's
      // local env.
      process.env.AGENT_CONSOLE_SOURCE_REPOS_DIR = '/tmp/test-source-repos';
      // Default: getRemoteUrl returns null so all tests can focus on the new
      // field rather than the remoteUrl shape.
      mockGit.getRemoteUrl.mockResolvedValue(null);
    });

    afterEach(() => {
      if (originalSourceReposDir === undefined) {
        delete process.env.AGENT_CONSOLE_SOURCE_REPOS_DIR;
      } else {
        process.env.AGENT_CONSOLE_SOURCE_REPOS_DIR = originalSourceReposDir;
      }
    });

    it('derives clonedSourceRepoPath when repo.path is under source-repos dir', async () => {
      const repo = createTestRepository({
        path: '/tmp/test-source-repos/owner/repo',
      });
      const enriched = await withRepositoryRemote(repo);

      expect(enriched.clonedSourceRepoPath).toBe('/tmp/test-source-repos/owner/repo');
    });

    it('sets clonedSourceRepoPath to null for paths outside source-repos dir', async () => {
      const repo = createTestRepository({
        path: '/home/alice/projects/my-repo',
      });
      const enriched = await withRepositoryRemote(repo);

      expect(enriched.clonedSourceRepoPath).toBeNull();
    });

    it('does NOT match sibling-prefix paths (path-segment boundary check)', async () => {
      // Naive `startsWith('/tmp/test-source-repos')` would incorrectly match
      // `/tmp/test-source-repos-other/...`. The `path.relative` based check
      // must produce a clean miss here so that an attacker-controlled
      // sibling-named directory cannot piggy-back on the "remove source repo"
      // affordance.
      const repo = createTestRepository({
        path: '/tmp/test-source-repos-other/owner/repo',
      });
      const enriched = await withRepositoryRemote(repo);

      expect(enriched.clonedSourceRepoPath).toBeNull();
    });

    it('sets clonedSourceRepoPath to null when repo.path equals the source-repos dir itself', async () => {
      // The dir itself is not a clone; `path.relative` returns '' here.
      const repo = createTestRepository({
        path: '/tmp/test-source-repos',
      });
      const enriched = await withRepositoryRemote(repo);

      expect(enriched.clonedSourceRepoPath).toBeNull();
    });
  });
});
