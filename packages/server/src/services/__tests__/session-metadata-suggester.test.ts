import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';
import type { AgentDefinition } from '@agent-console/shared';

vi.mock('child_process');

const mockAgent: AgentDefinition = {
  id: 'test-agent',
  name: 'Test Agent',
  command: 'test-cli',
  isBuiltIn: false,
  registeredAt: new Date().toISOString(),
  printModeArgs: ['-p', '--format', 'text'],
};

const mockAgentWithoutPrintMode: AgentDefinition = {
  id: 'no-print-agent',
  name: 'No Print Agent',
  command: 'no-print-cli',
  isBuiltIn: false,
  registeredAt: new Date().toISOString(),
};

describe('session-metadata-suggester', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  describe('getBranches', () => {
    it('should parse git branch output', async () => {
      vi.mocked(childProcess.execSync).mockReturnValue(
        '  main\n* feat/current-branch\n  fix/some-bug\n  remotes/origin/main\n'
      );

      const { getBranches } = await import('../session-metadata-suggester.js');

      const branches = getBranches('/repo');

      expect(branches).toContain('main');
      expect(branches).toContain('feat/current-branch');
      expect(branches).toContain('fix/some-bug');
      // Should not duplicate main from remotes
      expect(branches.filter(b => b === 'main').length).toBe(1);
    });

    it('should return empty array on error', async () => {
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('not a git repository');
      });

      const { getBranches } = await import('../session-metadata-suggester.js');

      const branches = getBranches('/not-a-repo');

      expect(branches).toEqual([]);
    });
  });

  describe('suggestSessionMetadata', () => {
    it('should return branch name from agent output', async () => {
      // First call for git branch, second for agent
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n  feat/existing\n')
        .mockReturnValueOnce('feat/add-dark-mode\n');

      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'Add a dark mode toggle',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBe('feat/add-dark-mode');
      expect(result.error).toBeUndefined();

      // Verify command was built correctly
      const calls = vi.mocked(childProcess.execSync).mock.calls;
      const agentCall = calls[1][0] as string;
      expect(agentCall).toContain('test-cli');
      expect(agentCall).toContain('-p');
      expect(agentCall).toContain('--format');
      expect(agentCall).toContain('text');
    });

    it('should return error if agent does not support print mode', async () => {
      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgentWithoutPrintMode,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('does not support non-interactive mode');
    });

    it('should sanitize invalid branch names', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('feat/Add Dark Mode!\n');

      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'Add dark mode',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      // Should be sanitized to lowercase with hyphens
      expect(result.branch).toMatch(/^[a-z0-9/-]+$/);
    });

    it('should return error when agent fails', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockImplementationOnce(() => {
          throw new Error('command not found');
        });

      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('Failed to suggest branch name');
    });

    it('should return error on empty response', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('   \n');

      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('empty response');
    });

    it('should use provided existingBranches instead of fetching', async () => {
      vi.mocked(childProcess.execSync).mockReturnValue('fix/auth-bug\n');

      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'Fix authentication',
        repositoryPath: '/repo',
        agent: mockAgent,
        existingBranches: ['feat/login', 'feat/signup'],
      });

      // Should only call execSync once (for agent), not for git branch
      expect(childProcess.execSync).toHaveBeenCalledTimes(1);
      expect(result.branch).toBe('fix/auth-bug');
    });

    it('should remove quotes from branch name', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('"feat/quoted-branch"\n');

      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'Some feature',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBe('feat/quoted-branch');
    });

    it('should work with no existing branches', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('')  // No branches
        .mockReturnValueOnce('feat/new-feature\n');

      const { suggestSessionMetadata } = await import('../session-metadata-suggester.js');

      const result = await suggestSessionMetadata({
        prompt: 'New feature',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBe('feat/new-feature');
    });
  });
});
