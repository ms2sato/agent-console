import { describe, it, expect } from 'bun:test';
import type { Repository } from '@agent-console/shared';
import { withRepositoryRemote } from '../repository-remote.js';

/**
 * Tests for withRepositoryRemote utility.
 *
 * Uses actual git operations against the current repository (integration-style)
 * to avoid Bun.spawn mocking issues in parallel test execution.
 * The core getRemoteUrl function is unit-tested in git.test.ts;
 * these tests verify the enrichment/spreading behavior of withRepositoryRemote.
 */

function createTestRepository(overrides?: Partial<Repository>): Repository {
  return {
    id: 'repo-1',
    name: 'test-repo',
    path: process.cwd(),
    createdAt: '2024-01-01T00:00:00Z',
    description: null,
    defaultAgentId: null,
    ...overrides,
  };
}

describe('withRepositoryRemote', () => {
  it('should enrich repository with remoteUrl from git remote', async () => {
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    // The current working directory is a git repo with a remote
    expect(enriched.remoteUrl).toBeDefined();
    expect(typeof enriched.remoteUrl).toBe('string');
    // Original fields preserved
    expect(enriched.id).toBe('repo-1');
    expect(enriched.name).toBe('test-repo');
    expect(enriched.path).toBe(process.cwd());
    expect(enriched.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('should not mutate the original repository object', async () => {
    const repo = createTestRepository();
    const enriched = await withRepositoryRemote(repo);

    expect(enriched).not.toBe(repo);
    // Original object is unchanged
    expect(repo.remoteUrl).toBeUndefined();
    expect(enriched.remoteUrl).toBeDefined();
  });

  it('should preserve all existing repository fields', async () => {
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
