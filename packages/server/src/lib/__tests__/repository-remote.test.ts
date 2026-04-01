import { describe, it, expect, mock } from 'bun:test';
import type { Repository } from '@agent-console/shared';

const mockGetRemoteUrl = mock(() => Promise.resolve('https://github.com/test/repo.git' as string | null));

mock.module('../git.js', () => ({
  getRemoteUrl: mockGetRemoteUrl,
}));

// Import after mock.module
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
  it('should enrich repository with remoteUrl from git remote', async () => {
    mockGetRemoteUrl.mockResolvedValueOnce('https://github.com/test/repo.git');
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    expect(enriched.remoteUrl).toBe('https://github.com/test/repo.git');
    expect(enriched.id).toBe('repo-1');
    expect(enriched.name).toBe('test-repo');
    expect(enriched.path).toBe('/tmp/test-repo');
    expect(enriched.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('should set remoteUrl to undefined when no remote exists', async () => {
    mockGetRemoteUrl.mockResolvedValueOnce(null);
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    expect(enriched.remoteUrl).toBeUndefined();
  });

  it('should not mutate the original repository object', async () => {
    mockGetRemoteUrl.mockResolvedValueOnce('https://github.com/test/repo.git');
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    expect(enriched).not.toBe(repo);
    expect(repo.remoteUrl).toBeUndefined();
    expect(enriched.remoteUrl).toBe('https://github.com/test/repo.git');
  });

  it('should preserve all existing repository fields', async () => {
    mockGetRemoteUrl.mockResolvedValueOnce('https://github.com/test/repo.git');
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
