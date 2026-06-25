import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createMockRunAsUser, type MockRunAsUser } from '../../__tests__/utils/mock-run-as-user.js';

import { DEFAULT_FORK_POINT_SPEC } from '@agent-console/shared';
import {
  __setRunAsUserForTesting,
  computeDefaultBaseSpec,
  resolveBaseSpec,
  resolveRef,
  getDiffData,
  getFileDiff,
  getFileLines,
} from '../git-diff-service.js';

describe('GitDiffService', () => {
  let gitMock: MockRunAsUser;

  beforeEach(() => {
    gitMock = createMockRunAsUser();
    __setRunAsUserForTesting(gitMock.fn);
  });

  afterEach(() => {
    __setRunAsUserForTesting(null);
  });

  describe('computeDefaultBaseSpec', () => {
    it('returns merge-base:origin/<default> when origin/<default> exists', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { stdout: 'refs/remotes/origin/main\n' });
      gitMock.respond(['rev-parse', '--verify', 'origin/main'], { stdout: 'abc1234\n' });

      const result = await computeDefaultBaseSpec('/repo/path', null);

      expect(result).toBe('merge-base:origin/main');
      expect(gitMock.findCall(['rev-parse', '--verify', 'origin/main'])).toBeDefined();
    });

    it('returns merge-base:<default> when default branch exists but origin/<default> does not', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { stdout: 'refs/remotes/origin/main\n' });
      gitMock.respond(['rev-parse', '--verify', 'origin/main'], { exitCode: 128, stderr: 'fatal: bad revision' });

      const result = await computeDefaultBaseSpec('/repo/path', null);

      expect(result).toBe('merge-base:main');
    });

    it('returns the first-commit hash when there is no default branch', async () => {
      // No default branch via symbolic-ref nor main/master fallbacks.
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { exitCode: 1 });
      gitMock.respond(['rev-parse', '--verify', 'main'], { exitCode: 128 });
      gitMock.respond(['rev-parse', '--verify', 'master'], { exitCode: 128 });
      gitMock.respond(['rev-list', '--max-parents=0', 'HEAD'], { stdout: 'first-commit-hash\n' });

      const result = await computeDefaultBaseSpec('/repo/path', null);

      expect(result).toBe('first-commit-hash');
      expect(gitMock.findCall(['rev-list', '--max-parents=0', 'HEAD'])).toBeDefined();
    });

    it('uses only the first root hash when rev-list emits multiple (merged unrelated histories)', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { exitCode: 1 });
      gitMock.respond(['rev-parse', '--verify', 'main'], { exitCode: 128 });
      gitMock.respond(['rev-parse', '--verify', 'master'], { exitCode: 128 });
      gitMock.respond(['rev-list', '--max-parents=0', 'HEAD'], { stdout: 'root1hash\nroot2hash\n' });

      const result = await computeDefaultBaseSpec('/repo/path', null);

      expect(result).toBe('root1hash');
    });

    it('falls back to HEAD when no default branch and no first commit', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { exitCode: 1 });
      gitMock.respond(['rev-parse', '--verify', 'main'], { exitCode: 128 });
      gitMock.respond(['rev-parse', '--verify', 'master'], { exitCode: 128 });
      gitMock.respond(['rev-list', '--max-parents=0', 'HEAD'], { exitCode: 1 });

      const result = await computeDefaultBaseSpec('/repo/path', null);

      expect(result).toBe('HEAD');
    });
  });

  describe('resolveBaseSpec', () => {
    it('resolves DEFAULT_FORK_POINT_SPEC via origin merge-base when origin exists', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { stdout: 'refs/remotes/origin/main\n' });
      gitMock.respond(['rev-parse', '--verify', 'origin/main'], { stdout: 'origin-tip-hash\n' });
      gitMock.respond(['merge-base', 'origin/main', 'HEAD'], { stdout: 'origin-merge-base\n' });

      const result = await resolveBaseSpec(DEFAULT_FORK_POINT_SPEC, '/repo/path', null);

      expect(result).toBe('origin-merge-base');
      expect(gitMock.findCall(['merge-base', 'origin/main', 'HEAD'])).toBeDefined();
    });

    it('falls back to local merge-base when origin/<default> is missing', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { stdout: 'refs/remotes/origin/main\n' });
      gitMock.respond(['rev-parse', '--verify', 'origin/main'], { exitCode: 128 });
      gitMock.respond(['merge-base', 'main', 'HEAD'], { stdout: 'local-merge-base\n' });

      const result = await resolveBaseSpec(DEFAULT_FORK_POINT_SPEC, '/repo/path', null);

      expect(result).toBe('local-merge-base');
      expect(gitMock.findCall(['merge-base', 'main', 'HEAD'])).toBeDefined();
    });

    it('falls back to first commit when no default branch (sentinel never hard-fails)', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { exitCode: 1 });
      gitMock.respond(['rev-parse', '--verify', 'main'], { exitCode: 128 });
      gitMock.respond(['rev-parse', '--verify', 'master'], { exitCode: 128 });
      gitMock.respond(['rev-list', '--max-parents=0', 'HEAD'], { stdout: 'first-commit-hash\n' });

      const result = await resolveBaseSpec(DEFAULT_FORK_POINT_SPEC, '/repo/path', null);

      expect(result).toBe('first-commit-hash');
    });

    it('uses only the first root hash when rev-list emits multiple (merged unrelated histories)', async () => {
      gitMock.respond(['symbolic-ref', 'refs/remotes/origin/HEAD'], { exitCode: 1 });
      gitMock.respond(['rev-parse', '--verify', 'main'], { exitCode: 128 });
      gitMock.respond(['rev-parse', '--verify', 'master'], { exitCode: 128 });
      gitMock.respond(['rev-list', '--max-parents=0', 'HEAD'], { stdout: 'root1hash\nroot2hash\n' });

      const result = await resolveBaseSpec(DEFAULT_FORK_POINT_SPEC, '/repo/path', null);

      expect(result).toBe('root1hash');
    });

    it('resolves merge-base:<ref> via merge-base', async () => {
      gitMock.respond(['merge-base', 'foo', 'HEAD'], { stdout: 'mb-hash\n' });

      const result = await resolveBaseSpec('merge-base:foo', '/repo/path', null);

      expect(result).toBe('mb-hash');
      expect(gitMock.findCall(['merge-base', 'foo', 'HEAD'])).toBeDefined();
    });

    it('returns null when merge-base:<ref> cannot be resolved (unrelated histories / deleted ref)', async () => {
      gitMock.respond(['merge-base', 'foo', 'HEAD'], { exitCode: 1 });

      const result = await resolveBaseSpec('merge-base:foo', '/repo/path', null);

      expect(result).toBeNull();
    });

    it('keeps an explicit commit hash pinned (no re-resolution to a different value)', async () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      gitMock.respond(['rev-parse', hash], { stdout: `${hash}\n` });

      const result = await resolveBaseSpec(hash, '/repo/path', null);

      expect(result).toBe(hash);
      expect(gitMock.findCall(['rev-parse', hash])).toBeDefined();
    });

    it('re-resolves a branch name to its current tip', async () => {
      gitMock.respond(['rev-parse', 'feature-branch'], { stdout: 'branch-tip-hash\n' });

      const result = await resolveBaseSpec('feature-branch', '/repo/path', null);

      expect(result).toBe('branch-tip-hash');
      expect(gitMock.findCall(['rev-parse', 'feature-branch'])).toBeDefined();
    });

    // Namespace fix: the sentinel lives in the reserved: namespace
    // (DEFAULT_FORK_POINT_SPEC === 'reserved:default-fork-point'). A real ref
    // literally named 'default-fork-point' (the bare string) must NOT be
    // intercepted as the sentinel — it must fall through to rev-parse so it
    // round-trips like any other branch/tag.
    it('resolves a real ref literally named "default-fork-point" via rev-parse (not the sentinel path)', async () => {
      gitMock.respond(['rev-parse', 'default-fork-point'], { stdout: 'real-ref-hash\n' });

      const result = await resolveBaseSpec('default-fork-point', '/repo/path', null);

      expect(result).toBe('real-ref-hash');
      expect(gitMock.findCall(['rev-parse', 'default-fork-point'])).toBeDefined();
      // The sentinel chain (computeDefaultBaseSpec) must not have been invoked.
      expect(gitMock.findCall(['symbolic-ref', 'refs/remotes/origin/HEAD'])).toBeUndefined();
    });
  });

  describe('resolveRef', () => {
    it('should resolve valid ref to commit hash', async () => {
      gitMock.respond(['rev-parse', 'main'], { stdout: 'resolved-hash-123\n' });

      const result = await resolveRef('main', '/repo/path', null);

      expect(result).toBe('resolved-hash-123');
      expect(gitMock.findCall(['rev-parse', 'main'])).toBeDefined();
    });

    it('should return null for invalid ref', async () => {
      gitMock.respond(['rev-parse', 'invalid-ref'], { exitCode: 128 });

      const result = await resolveRef('invalid-ref', '/repo/path', null);

      expect(result).toBeNull();
    });
  });

  describe('getDiffData', () => {
    it('should return diff data with files', async () => {
      gitMock.respond(['diff', 'base-commit'], { stdout: 'diff --git a/file.ts b/file.ts\n+new line\n' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '10\t5\tfile.ts\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: ' M file.ts\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

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
      // generateUntrackedFileDiff reads the actual file; use a temp directory.
      const tmpDir = join('/tmp', `getDiffData-untracked-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, 'new-file.ts'), 'console.log("hello");\n');
      try {
        gitMock.respond(['diff', 'base-commit'], { stdout: '' });
        gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '' });
        gitMock.respond(['status', '--porcelain', '-uall'], { stdout: '?? new-file.ts\n' });
        gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: 'new-file.ts\n' });

        const result = await getDiffData(tmpDir, 'base-commit', null);

        expect(result.summary.files.some(f => f.path === 'new-file.ts')).toBe(true);
        expect(result.summary.files.find(f => f.path === 'new-file.ts')?.status).toBe('untracked');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should handle multiple untracked files (processed in parallel)', async () => {
      // This test verifies that multiple untracked files are all included in the result.
      // The parallel processing optimization should not affect the final output.
      const tmpDir = join('/tmp', `getDiffData-multi-untracked-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, 'file-a.ts'), 'a\n');
      writeFileSync(join(tmpDir, 'file-b.ts'), 'b\n');
      writeFileSync(join(tmpDir, 'file-c.ts'), 'c\n');
      try {
        gitMock.respond(['diff', 'base-commit'], { stdout: '' });
        gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '' });
        gitMock.respond(['status', '--porcelain', '-uall'], { stdout: '?? file-a.ts\n?? file-b.ts\n?? file-c.ts\n' });
        gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: 'file-a.ts\nfile-b.ts\nfile-c.ts\n' });

        const result = await getDiffData(tmpDir, 'base-commit', null);

        // All three untracked files should be included
        expect(result.summary.files).toHaveLength(3);
        expect(result.summary.files.map(f => f.path)).toEqual(['file-a.ts', 'file-b.ts', 'file-c.ts']);

        // All should be marked as untracked with unstaged state
        for (const file of result.summary.files) {
          expect(file.status).toBe('untracked');
          expect(file.stageState).toBe('unstaged');
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should handle empty diff gracefully', async () => {
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: '' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      expect(result.summary.files).toEqual([]);
      expect(result.summary.totalAdditions).toBe(0);
      expect(result.summary.totalDeletions).toBe(0);
    });

    it('should handle git errors gracefully', async () => {
      // All git invocations fail with non-zero exit; service should log and
      // return an empty result instead of propagating the error.
      gitMock.fallback({ exitCode: 1, stderr: 'git error' });

      const result = await getDiffData('/repo/path', 'invalid-commit', null);

      expect(result.summary.files).toEqual([]);
      expect(result.rawDiff).toBe('');
    });

    it('should detect staged files', async () => {
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '5\t0\tstaged-file.ts\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: 'A  staged-file.ts\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      const file = result.summary.files.find(f => f.path === 'staged-file.ts');
      expect(file).toBeDefined();
      expect(file?.stageState).toBe('staged');
    });

    it('should detect partially staged files', async () => {
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '5\t2\tpartial-file.ts\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: 'MM partial-file.ts\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      const file = result.summary.files.find(f => f.path === 'partial-file.ts');
      expect(file).toBeDefined();
      expect(file?.stageState).toBe('partial');
    });

    it('should handle binary files', async () => {
      gitMock.respond(['diff', 'base-commit'], { stdout: 'Binary files differ\n' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '-\t-\timage.png\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: ' M image.png\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      const file = result.summary.files.find(f => f.path === 'image.png');
      expect(file).toBeDefined();
      expect(file?.isBinary).toBe(true);
    });

    it('should handle quoted filenames with spaces', async () => {
      // Git quotes filenames containing spaces or special characters
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '5\t0\tfile with spaces.ts\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: ' M "file with spaces.ts"\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      const file = result.summary.files.find(f => f.path === 'file with spaces.ts');
      expect(file).toBeDefined();
      expect(file?.stageState).toBe('unstaged');
    });

    it('should handle renamed files without quotes', async () => {
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '0\t0\tnew-name.ts\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: 'R  old-name.ts -> new-name.ts\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      const file = result.summary.files.find(f => f.path === 'new-name.ts');
      expect(file).toBeDefined();
      expect(file?.status).toBe('renamed');
      expect(file?.oldPath).toBe('old-name.ts');
    });

    it('should handle renamed files with quoted names', async () => {
      // Both old and new names are quoted when they contain special characters
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '0\t0\tnew file.ts\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: 'R  "old file.ts" -> "new file.ts"\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      const file = result.summary.files.find(f => f.path === 'new file.ts');
      expect(file).toBeDefined();
      expect(file?.status).toBe('renamed');
      expect(file?.oldPath).toBe('old file.ts');
    });

    it('should handle renamed files with mixed quoting', async () => {
      // Only one name is quoted (e.g., adding spaces to a previously simple filename)
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '0\t0\tfile with spaces.ts\n' });
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: 'R  simple.ts -> "file with spaces.ts"\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      const file = result.summary.files.find(f => f.path === 'file with spaces.ts');
      expect(file).toBeDefined();
      expect(file?.status).toBe('renamed');
      expect(file?.oldPath).toBe('simple.ts');
    });

    it('should skip malformed status lines gracefully', async () => {
      // Lines that don't match expected format should be skipped
      gitMock.respond(['diff', 'base-commit'], { stdout: '' });
      gitMock.respond(['diff', '--numstat', 'base-commit'], { stdout: '5\t0\tvalid-file.ts\n' });
      // First line is valid, second is malformed (only one character)
      gitMock.respond(['status', '--porcelain', '-uall'], { stdout: ' M valid-file.ts\nX\n' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getDiffData('/repo/path', 'base-commit', null);

      // Should still process the valid file
      expect(result.summary.files).toHaveLength(1);
      expect(result.summary.files[0].path).toBe('valid-file.ts');
    });
  });

  describe('getFileDiff', () => {
    it('should use targeted git diff command with -- file path', async () => {
      const expectedDiff = 'diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,4 @@\n line1\n+new line\n line2\n';
      gitMock.respond(['diff', 'base-commit', '--', 'src/file.ts'], { stdout: expectedDiff });

      const result = await getFileDiff('/repo/path', 'base-commit', 'src/file.ts', null);

      expect(result).toBe(expectedDiff);
      expect(gitMock.findCall(['diff', 'base-commit', '--', 'src/file.ts'])).toBeDefined();
      // Should NOT call the unscoped diff (full repo diff)
      expect(gitMock.findCall(['diff', 'base-commit'])).toBeUndefined();
    });

    it('should return empty string for invalid file path', async () => {
      const result = await getFileDiff('/repo/path', 'base-commit', '../etc/passwd', null);

      expect(result).toBe('');
      expect(gitMock.calls.length).toBe(0);
    });

    it('should fallback to untracked file diff when git diff returns empty', async () => {
      // generateUntrackedFileDiff reads the actual file, so use a temp directory
      const tmpDir = join('/tmp', `getFileDiff-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, 'new-file.ts'), 'console.log("hello");\n');

      try {
        gitMock.respond(['diff', 'base-commit', '--', 'new-file.ts'], { stdout: '' });
        gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: 'new-file.ts\n' });

        const result = await getFileDiff(tmpDir, 'base-commit', 'new-file.ts', null);

        expect(result).not.toBe('');
        expect(result).toContain('diff --git a/new-file.ts b/new-file.ts');
        expect(gitMock.findCall(['ls-files', '--others', '--exclude-standard'])).toBeDefined();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return empty string when file has no changes and is not untracked', async () => {
      gitMock.respond(['diff', 'base-commit', '--', 'unchanged-file.ts'], { stdout: '' });
      gitMock.respond(['ls-files', '--others', '--exclude-standard'], { stdout: '' });

      const result = await getFileDiff('/repo/path', 'base-commit', 'unchanged-file.ts', null);

      expect(result).toBe('');
    });

    it('should return empty string on git error', async () => {
      gitMock.respond(['diff', 'bad-commit', '--', 'src/file.ts'], { exitCode: 128, stderr: 'fatal: bad revision' });

      const result = await getFileDiff('/repo/path', 'bad-commit', 'src/file.ts', null);

      expect(result).toBe('');
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

      const result = await getFileLines(tmpDir, 'file.ts', 2, 4, 'working-dir', null);

      expect(result).toEqual(['line2', 'line3', 'line4']);
    });

    it('commit ref: returns correct lines via git show', async () => {
      const content = 'alpha\nbeta\ngamma\ndelta\n';
      gitMock.respond(['show', 'abc123:src/file.ts'], { stdout: content });

      const result = await getFileLines('/repo/path', 'src/file.ts', 1, 2, 'abc123', null);

      expect(gitMock.findCall(['show', 'abc123:src/file.ts'])).toBeDefined();
      expect(result).toEqual(['alpha', 'beta']);
    });

    it('clamps out-of-bounds range', async () => {
      const content = 'line1\nline2\nline3\n';
      writeFileSync(join(tmpDir, 'file.ts'), content);

      const result = await getFileLines(tmpDir, 'file.ts', 2, 100, 'working-dir', null);

      // Content splits to ['line1', 'line2', 'line3', ''], so allLines.length=4
      // clampedEnd = min(4, 100) = 4, slice(1, 4) = ['line2', 'line3', '']
      expect(result).toEqual(['line2', 'line3', '']);
    });

    it('returns empty array when start > end after clamping', async () => {
      const content = 'line1\nline2\nline3\n';
      writeFileSync(join(tmpDir, 'file.ts'), content);

      const result = await getFileLines(tmpDir, 'file.ts', 100, 200, 'working-dir', null);

      expect(result).toEqual([]);
    });

    it('throws on invalid file path (path traversal)', async () => {
      await expect(
        getFileLines(tmpDir, '../etc/passwd', 1, 10, 'working-dir', null)
      ).rejects.toThrow('Invalid file path');
    });

    it('throws on absolute path', async () => {
      await expect(
        getFileLines(tmpDir, '/etc/passwd', 1, 10, 'working-dir', null)
      ).rejects.toThrow('Invalid file path');
    });

    it('throws when file does not exist in working-dir', async () => {
      await expect(
        getFileLines(tmpDir, 'nonexistent.ts', 1, 10, 'working-dir', null)
      ).rejects.toThrow('Failed to read nonexistent.ts from working directory');
    });

    it('clamps negative startLine to 1', async () => {
      const content = 'line1\nline2\nline3\n';
      writeFileSync(join(tmpDir, 'file.ts'), content);

      const result = await getFileLines(tmpDir, 'file.ts', -5, 2, 'working-dir', null);

      expect(result).toEqual(['line1', 'line2']);
    });

    it('throws when git show returns null', async () => {
      gitMock.respond(['show', 'abc123:src/file.ts'], { exitCode: 128, stderr: 'fatal: not found' });

      await expect(
        getFileLines('/repo/path', 'src/file.ts', 1, 5, 'abc123', null)
      ).rejects.toThrow('Failed to read src/file.ts at ref abc123');
    });
  });

  // Note: File Watching tests require real file system and are tested separately.
  // Run in isolation: bun test src/services/__tests__/git-diff-service.test.ts
  // These tests verify the chokidar integration works correctly.
});
