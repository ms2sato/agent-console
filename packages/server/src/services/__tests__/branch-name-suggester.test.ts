import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';

vi.mock('child_process');

describe('branch-name-suggester', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  describe('inferBranchNamingConvention', () => {
    it('should detect common prefixes from branches', async () => {
      const { inferBranchNamingConvention } = await import('../branch-name-suggester.js');

      const branches = [
        'feat/add-login',
        'feat/user-profile',
        'fix/button-color',
        'feat/settings-page',
        'main',
      ];

      const result = inferBranchNamingConvention(branches);

      expect(result).toContain('feat/');
      expect(result).toContain('fix/');
    });

    it('should filter out auto-generated worktree branches', async () => {
      const { inferBranchNamingConvention } = await import('../branch-name-suggester.js');

      const branches = [
        'wt-001-abcd',
        'wt-002-efgh',
        'feat/real-feature',
        'main',
      ];

      const result = inferBranchNamingConvention(branches);

      expect(result).toContain('feat/');
      expect(result).not.toContain('wt-001');
    });

    it('should return default message when no meaningful branches', async () => {
      const { inferBranchNamingConvention } = await import('../branch-name-suggester.js');

      const branches = ['wt-001-abcd', 'wt-002-efgh'];

      const result = inferBranchNamingConvention(branches);

      expect(result).toContain('No clear naming convention detected');
      expect(result).toContain('feat/');
    });

    it('should handle empty branches array', async () => {
      const { inferBranchNamingConvention } = await import('../branch-name-suggester.js');

      const result = inferBranchNamingConvention([]);

      expect(result).toContain('No clear naming convention detected');
    });
  });

  describe('getBranches', () => {
    it('should parse git branch output', async () => {
      vi.mocked(childProcess.execSync).mockReturnValue(
        '  main\n* feat/current-branch\n  fix/some-bug\n  remotes/origin/main\n'
      );

      const { getBranches } = await import('../branch-name-suggester.js');

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

      const { getBranches } = await import('../branch-name-suggester.js');

      const branches = getBranches('/not-a-repo');

      expect(branches).toEqual([]);
    });
  });

  describe('suggestBranchName', () => {
    it('should return branch name from claude output', async () => {
      // First call for git branch, second for claude
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n  feat/existing\n')
        .mockReturnValueOnce('feat/add-dark-mode\n');

      const { suggestBranchName } = await import('../branch-name-suggester.js');

      const result = await suggestBranchName({
        prompt: 'Add a dark mode toggle',
        repositoryPath: '/repo',
      });

      expect(result.branch).toBe('feat/add-dark-mode');
      expect(result.error).toBeUndefined();
    });

    it('should sanitize invalid branch names', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('feat/Add Dark Mode!\n');

      const { suggestBranchName } = await import('../branch-name-suggester.js');

      const result = await suggestBranchName({
        prompt: 'Add dark mode',
        repositoryPath: '/repo',
      });

      // Should be sanitized to lowercase with hyphens
      expect(result.branch).toMatch(/^[a-z0-9/-]+$/);
    });

    it('should return error when claude fails', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockImplementationOnce(() => {
          throw new Error('claude command not found');
        });

      const { suggestBranchName } = await import('../branch-name-suggester.js');

      const result = await suggestBranchName({
        prompt: 'Some task',
        repositoryPath: '/repo',
      });

      expect(result.branch).toBe('');
      expect(result.error).toContain('Failed to suggest branch name');
    });

    it('should return error on empty response', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('   \n');

      const { suggestBranchName } = await import('../branch-name-suggester.js');

      const result = await suggestBranchName({
        prompt: 'Some task',
        repositoryPath: '/repo',
      });

      expect(result.branch).toBe('');
      expect(result.error).toContain('empty response');
    });

    it('should use provided existingBranches instead of fetching', async () => {
      vi.mocked(childProcess.execSync).mockReturnValue('fix/auth-bug\n');

      const { suggestBranchName } = await import('../branch-name-suggester.js');

      const result = await suggestBranchName({
        prompt: 'Fix authentication',
        repositoryPath: '/repo',
        existingBranches: ['feat/login', 'feat/signup'],
      });

      // Should only call execSync once (for claude), not for git branch
      expect(childProcess.execSync).toHaveBeenCalledTimes(1);
      expect(result.branch).toBe('fix/auth-bug');
    });

    it('should remove quotes from branch name', async () => {
      vi.mocked(childProcess.execSync)
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('"feat/quoted-branch"\n');

      const { suggestBranchName } = await import('../branch-name-suggester.js');

      const result = await suggestBranchName({
        prompt: 'Some feature',
        repositoryPath: '/repo',
      });

      expect(result.branch).toBe('feat/quoted-branch');
    });
  });
});
