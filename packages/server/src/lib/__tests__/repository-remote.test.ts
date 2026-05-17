import { describe, it, expect, beforeEach } from 'bun:test';
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
});
