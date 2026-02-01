import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';

import {
  calculateBaseCommit,
  resolveRef,
  getDiffData,
  getFileLines,
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

    it('should handle multiple untracked files (processed in parallel)', async () => {
      // This test verifies that multiple untracked files are all included in the result.
      // The parallel processing optimization should not affect the final output.
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('');
      mockGit.getStatusPorcelain.mockResolvedValue('?? file-a.ts\n?? file-b.ts\n?? file-c.ts');
      mockGit.getUntrackedFiles.mockResolvedValue(['file-a.ts', 'file-b.ts', 'file-c.ts']);

      const result = await getDiffData('/repo/path', 'base-commit');

      // All three untracked files should be included
      expect(result.summary.files).toHaveLength(3);
      expect(result.summary.files.map(f => f.path)).toEqual(['file-a.ts', 'file-b.ts', 'file-c.ts']);

      // All should be marked as untracked with unstaged state
      for (const file of result.summary.files) {
        expect(file.status).toBe('untracked');
        expect(file.stageState).toBe('unstaged');
      }
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

    it('should handle quoted filenames with spaces', async () => {
      // Git quotes filenames containing spaces or special characters
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('5\t0\tfile with spaces.ts');
      mockGit.getStatusPorcelain.mockResolvedValue(' M "file with spaces.ts"');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      const file = result.summary.files.find(f => f.path === 'file with spaces.ts');
      expect(file).toBeDefined();
      expect(file?.stageState).toBe('unstaged');
    });

    it('should handle renamed files without quotes', async () => {
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('0\t0\tnew-name.ts');
      mockGit.getStatusPorcelain.mockResolvedValue('R  old-name.ts -> new-name.ts');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      const file = result.summary.files.find(f => f.path === 'new-name.ts');
      expect(file).toBeDefined();
      expect(file?.status).toBe('renamed');
      expect(file?.oldPath).toBe('old-name.ts');
    });

    it('should handle renamed files with quoted names', async () => {
      // Both old and new names are quoted when they contain special characters
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('0\t0\tnew file.ts');
      mockGit.getStatusPorcelain.mockResolvedValue('R  "old file.ts" -> "new file.ts"');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      const file = result.summary.files.find(f => f.path === 'new file.ts');
      expect(file).toBeDefined();
      expect(file?.status).toBe('renamed');
      expect(file?.oldPath).toBe('old file.ts');
    });

    it('should handle renamed files with mixed quoting', async () => {
      // Only one name is quoted (e.g., adding spaces to a previously simple filename)
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('0\t0\tfile with spaces.ts');
      mockGit.getStatusPorcelain.mockResolvedValue('R  simple.ts -> "file with spaces.ts"');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      const file = result.summary.files.find(f => f.path === 'file with spaces.ts');
      expect(file).toBeDefined();
      expect(file?.status).toBe('renamed');
      expect(file?.oldPath).toBe('simple.ts');
    });

    it('should skip malformed status lines gracefully', async () => {
      // Lines that don't match expected format should be skipped
      mockGit.getDiff.mockResolvedValue('');
      mockGit.getDiffNumstat.mockResolvedValue('5\t0\tvalid-file.ts');
      // First line is valid, second is malformed (only one character)
      mockGit.getStatusPorcelain.mockResolvedValue(' M valid-file.ts\nX');
      mockGit.getUntrackedFiles.mockResolvedValue([]);

      const result = await getDiffData('/repo/path', 'base-commit');

      // Should still process the valid file
      expect(result.summary.files).toHaveLength(1);
      expect(result.summary.files[0].path).toBe('valid-file.ts');
    });
  });

  describe('getFileLines', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join('/tmp', `git-diff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('working-dir: returns correct lines from file', async () => {
      const content = 'line1\nline2\nline3\nline4\nline5\n';
      writeFileSync(join(tmpDir, 'file.ts'), content);

      const result = await getFileLines(tmpDir, 'file.ts', 2, 4, 'working-dir');

      expect(result).toEqual(['line2', 'line3', 'line4']);
    });

    it('commit ref: returns correct lines via git show', async () => {
      const content = 'alpha\nbeta\ngamma\ndelta\n';
      mockGit.gitSafe.mockResolvedValue(content);

      const result = await getFileLines('/repo/path', 'src/file.ts', 1, 2, 'abc123');

      expect(mockGit.gitSafe).toHaveBeenCalledWith(['show', 'abc123:src/file.ts'], '/repo/path');
      expect(result).toEqual(['alpha', 'beta']);
    });

    it('clamps out-of-bounds range', async () => {
      const content = 'line1\nline2\nline3\n';
      writeFileSync(join(tmpDir, 'file.ts'), content);

      const result = await getFileLines(tmpDir, 'file.ts', 2, 100, 'working-dir');

      // Content splits to ['line1', 'line2', 'line3', ''], so allLines.length=4
      // clampedEnd = min(4, 100) = 4, slice(1, 4) = ['line2', 'line3', '']
      expect(result).toEqual(['line2', 'line3', '']);
    });

    it('returns empty array when start > end after clamping', async () => {
      const content = 'line1\nline2\nline3\n';
      writeFileSync(join(tmpDir, 'file.ts'), content);

      const result = await getFileLines(tmpDir, 'file.ts', 100, 200, 'working-dir');

      expect(result).toEqual([]);
    });

    it('throws on invalid file path (path traversal)', async () => {
      await expect(
        getFileLines(tmpDir, '../etc/passwd', 1, 10, 'working-dir')
      ).rejects.toThrow('Invalid file path');
    });

    it('throws on absolute path', async () => {
      await expect(
        getFileLines(tmpDir, '/etc/passwd', 1, 10, 'working-dir')
      ).rejects.toThrow('Invalid file path');
    });

    it('throws when file does not exist in working-dir', async () => {
      await expect(
        getFileLines(tmpDir, 'nonexistent.ts', 1, 10, 'working-dir')
      ).rejects.toThrow('Failed to read nonexistent.ts from working directory');
    });

    it('clamps negative startLine to 1', async () => {
      const content = 'line1\nline2\nline3\n';
      writeFileSync(join(tmpDir, 'file.ts'), content);

      const result = await getFileLines(tmpDir, 'file.ts', -5, 2, 'working-dir');

      expect(result).toEqual(['line1', 'line2']);
    });

    it('throws when git show returns null', async () => {
      mockGit.gitSafe.mockResolvedValue(null);

      await expect(
        getFileLines('/repo/path', 'src/file.ts', 1, 5, 'abc123')
      ).rejects.toThrow('Failed to read src/file.ts at ref abc123');
    });
  });

  // Note: File Watching tests require real file system and are tested separately.
  // Run in isolation: bun test src/services/__tests__/git-diff-service.test.ts
  // These tests verify the chokidar integration works correctly.
});
