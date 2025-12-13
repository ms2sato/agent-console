import { describe, it, expect, beforeEach } from 'bun:test';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import {
  calculateBaseCommit,
  resolveRef,
  getDiffData,
} from '../git-diff-service.js';

describe('GitDiffService', () => {
  beforeEach(() => {
    resetGitMocks();
  });

  describe('calculateBaseCommit', () => {
    it('should return merge-base when default branch exists', async () => {
      mockGit.getDefaultBranch.mockResolvedValue('main');
      mockGit.getMergeBaseSafe.mockResolvedValue('abc123def456');

      const result = await calculateBaseCommit('/repo/path');

      expect(result).toBe('abc123def456');
      expect(mockGit.getDefaultBranch).toHaveBeenCalledWith('/repo/path');
      expect(mockGit.getMergeBaseSafe).toHaveBeenCalledWith('main', 'HEAD', '/repo/path');
    });

    it('should fallback to first commit when no default branch', async () => {
      mockGit.getDefaultBranch.mockResolvedValue(null);
      mockGit.gitSafe.mockResolvedValue('first-commit-hash');

      const result = await calculateBaseCommit('/repo/path');

      expect(result).toBe('first-commit-hash');
      expect(mockGit.gitSafe).toHaveBeenCalledWith(
        ['rev-list', '--max-parents=0', 'HEAD'],
        '/repo/path'
      );
    });
  });

  describe('resolveRef', () => {
    it('should resolve valid ref to commit hash', async () => {
      mockGit.gitSafe.mockResolvedValue('resolved-hash-123');

      const result = await resolveRef('main', '/repo/path');

      expect(result).toBe('resolved-hash-123');
      expect(mockGit.gitSafe).toHaveBeenCalledWith(['rev-parse', 'main'], '/repo/path');
    });

    it('should return null for invalid ref', async () => {
      mockGit.gitSafe.mockResolvedValue(null);

      const result = await resolveRef('invalid-ref', '/repo/path');

      expect(result).toBeNull();
    });
  });

  describe('getDiffData', () => {
    it('should return diff data with files', async () => {
      // Setup mocks
      mockGit.getDiff.mockResolvedValue('diff --git a/file.ts b/file.ts\n+new line\n');
      mockGit.getDiffNumstat.mockResolvedValue('10\t5\tfile.ts');
      mockGit.getStatusPorcelain.mockResolvedValue(' M file.ts');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      expect(result.summary.baseCommit).toBe('base-commit');
      expect(result.summary.files).toHaveLength(1);
      expect(result.summary.files[0].path).toBe('file.ts');
      expect(result.summary.files[0].additions).toBe(10);
      expect(result.summary.files[0].deletions).toBe(5);
      expect(result.summary.totalAdditions).toBe(10);
      expect(result.summary.totalDeletions).toBe(5);
      expect(result.rawDiff).toContain('diff --git');
    });

    it('should include untracked files', async () => {
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('');
      mockGit.getStatusPorcelain.mockResolvedValue('?? new-file.ts');
      mockGit.getUntrackedFiles.mockResolvedValue(['new-file.ts']);

      const result = await getDiffData('/repo/path', 'base-commit');

      expect(result.summary.files.some(f => f.path === 'new-file.ts')).toBe(true);
      expect(result.summary.files.find(f => f.path === 'new-file.ts')?.status).toBe('untracked');
    });

    it('should handle empty diff gracefully', async () => {
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('');
      mockGit.getStatusPorcelain.mockResolvedValue('');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      expect(result.summary.files).toEqual([]);
      expect(result.summary.totalAdditions).toBe(0);
      expect(result.summary.totalDeletions).toBe(0);
    });

    it('should handle git errors gracefully', async () => {
      mockGit.getDiff.mockRejectedValue(new Error('git error'));
      mockGit.getDiffNumstat.mockRejectedValue(new Error('git error'));
      mockGit.getStatusPorcelain.mockRejectedValue(new Error('git error'));
      mockGit.getUntrackedFiles.mockRejectedValue(new Error('git error'));

      const result = await getDiffData('/repo/path', 'invalid-commit');

      expect(result.summary.files).toEqual([]);
      expect(result.rawDiff).toBe('');
    });

    it('should detect staged files', async () => {
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('5\t0\tstaged-file.ts');
      mockGit.getStatusPorcelain.mockResolvedValue('A  staged-file.ts');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      const file = result.summary.files.find(f => f.path === 'staged-file.ts');
      expect(file).toBeDefined();
      expect(file?.stageState).toBe('staged');
    });

    it('should detect partially staged files', async () => {
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('5\t2\tpartial-file.ts');
      mockGit.getStatusPorcelain.mockResolvedValue('MM partial-file.ts');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      const file = result.summary.files.find(f => f.path === 'partial-file.ts');
      expect(file).toBeDefined();
      expect(file?.stageState).toBe('partial');
    });

    it('should handle binary files', async () => {
      mockGit.getDiff.mockResolvedValue('Binary files differ');
      mockGit.getDiffNumstat.mockResolvedValue('-\t-\timage.png');
      mockGit.getStatusPorcelain.mockResolvedValue(' M image.png');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      const file = result.summary.files.find(f => f.path === 'image.png');
      expect(file).toBeDefined();
      expect(file?.isBinary).toBe(true);
    });
  });

  // Note: File Watching tests require real file system and are tested separately.
  // Run in isolation: bun test src/services/__tests__/git-diff-service.test.ts
  // These tests verify the chokidar integration works correctly.
});
