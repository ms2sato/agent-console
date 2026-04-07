import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { parseBranchFromHead, resolveHeadFilePath, BranchWatcherService } from '../branch-watcher-service.js';
import * as path from 'node:path';
import * as os from 'node:os';

// Use Bun APIs and shell commands for file operations to avoid memfs
// mock contamination from mock-fs-helper.ts (which globally mocks node:fs)
async function createTempDir(prefix: string): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await Bun.spawn(['mkdir', '-p', tmpDir]).exited;
  return tmpDir;
}

async function removeTempDir(dir: string): Promise<void> {
  await Bun.spawn(['rm', '-rf', dir]).exited;
}

async function createDir(dir: string): Promise<void> {
  await Bun.spawn(['mkdir', '-p', dir]).exited;
}

describe('parseBranchFromHead', () => {
  it('should parse branch name from ref format', () => {
    expect(parseBranchFromHead('ref: refs/heads/main\n')).toBe('main');
    expect(parseBranchFromHead('ref: refs/heads/feat/dynamic-branch-tracking')).toBe('feat/dynamic-branch-tracking');
    expect(parseBranchFromHead('ref: refs/heads/fix-123')).toBe('fix-123');
  });

  it('should return (detached) for raw commit hash', () => {
    expect(parseBranchFromHead('abc123def456\n')).toBe('(detached)');
    expect(parseBranchFromHead('4b825dc642cb6eb9a060e54bf899d69f82563773')).toBe('(detached)');
  });

  it('should return (detached) for empty content', () => {
    expect(parseBranchFromHead('')).toBe('(detached)');
    expect(parseBranchFromHead('  \n')).toBe('(detached)');
  });

  it('should handle trailing whitespace', () => {
    expect(parseBranchFromHead('ref: refs/heads/main  \n')).toBe('main');
  });
});

describe('resolveHeadFilePath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('branch-watcher-test-');
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it('should resolve HEAD for main repository (.git directory)', async () => {
    const gitDir = path.join(tmpDir, '.git');
    await createDir(gitDir);
    await Bun.write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const result = await resolveHeadFilePath(tmpDir);
    expect(result).toBe(path.join(gitDir, 'HEAD'));
  });

  it('should resolve HEAD for worktree (.git file with gitdir)', async () => {
    const mainRepoGitDir = path.join(tmpDir, 'main-repo', '.git');
    const worktreeGitDir = path.join(mainRepoGitDir, 'worktrees', 'wt-001');
    await createDir(worktreeGitDir);
    await Bun.write(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature-branch\n');

    const worktreeDir = path.join(tmpDir, 'wt-001');
    await createDir(worktreeDir);
    await Bun.write(path.join(worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`);

    const result = await resolveHeadFilePath(worktreeDir);
    expect(result).toBe(path.join(worktreeGitDir, 'HEAD'));
  });

  it('should resolve HEAD for worktree with relative gitdir path', async () => {
    const mainRepoDir = path.join(tmpDir, 'main-repo');
    const gitDir = path.join(mainRepoDir, '.git');
    const worktreeGitDir = path.join(gitDir, 'worktrees', 'wt-001');
    await createDir(worktreeGitDir);
    await Bun.write(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n');

    const worktreeDir = path.join(tmpDir, 'wt-001');
    await createDir(worktreeDir);
    const relativeGitdir = path.relative(worktreeDir, worktreeGitDir);
    await Bun.write(path.join(worktreeDir, '.git'), `gitdir: ${relativeGitdir}\n`);

    const result = await resolveHeadFilePath(worktreeDir);
    expect(result).toBe(path.join(worktreeGitDir, 'HEAD'));
  });

  it('should return null when .git does not exist', async () => {
    const result = await resolveHeadFilePath(tmpDir);
    expect(result).toBeNull();
  });
});

describe('BranchWatcherService', () => {
  // Create a mock FSWatcher that exposes the callback for manual triggering.
  // This avoids depending on real fs.watch which is mocked by memfs in the full test suite.
  let mockWatchCallbacks: Map<string, (eventType: string, filename: string | null) => void>;
  let mockWatchCloseFns: Map<string, ReturnType<typeof mock>>;

  function createMockWatch() {
    mockWatchCallbacks = new Map();
    mockWatchCloseFns = new Map();

    return ((filePath: string, callback: (eventType: string, filename: string | null) => void) => {
      const key = filePath;
      mockWatchCallbacks.set(key, callback);
      const closeFn = mock(() => { mockWatchCallbacks.delete(key); });
      mockWatchCloseFns.set(key, closeFn);
      const emitter = new EventEmitter() as EventEmitter & { close: typeof closeFn };
      emitter.close = closeFn;
      return emitter as unknown as FSWatcher;
    }) as unknown as typeof import('node:fs').watch;
  }

  it('should start and stop watching', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      await Bun.write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(async () => {}, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');
      expect(service.isWatching('session-1')).toBe(true);

      service.stopWatching('session-1');
      expect(service.isWatching('session-1')).toBe(false);
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should detect branch change when HEAD file changes', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      const headPath = path.join(gitDir, 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/main\n');

      const onBranchChanged = mock(async () => {});
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(onBranchChanged, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');

      // Simulate file change: write new content then trigger watcher
      await Bun.write(headPath, 'ref: refs/heads/feature-branch\n');
      const callback = mockWatchCallbacks.get(headPath);
      callback?.('change', 'HEAD');

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(onBranchChanged).toHaveBeenCalledWith('session-1', 'feature-branch');

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should not fire callback when branch has not changed', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      const headPath = path.join(gitDir, 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/main\n');

      const onBranchChanged = mock(async () => {});
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(onBranchChanged, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');

      // Trigger watcher without changing content
      const callback = mockWatchCallbacks.get(headPath);
      callback?.('change', 'HEAD');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(onBranchChanged).not.toHaveBeenCalled();

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should handle detached HEAD state', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      const headPath = path.join(gitDir, 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/main\n');

      const onBranchChanged = mock(async () => {});
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(onBranchChanged, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');

      // Simulate detached HEAD
      await Bun.write(headPath, '4b825dc642cb6eb9a060e54bf899d69f82563773\n');
      mockWatchCallbacks.get(headPath)?.('change', 'HEAD');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(onBranchChanged).toHaveBeenCalledWith('session-1', '(detached)');

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should debounce rapid changes', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      const headPath = path.join(gitDir, 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/main\n');

      const onBranchChanged = mock(async () => {});
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(onBranchChanged, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');

      const callback = mockWatchCallbacks.get(headPath)!;

      // Rapid triggers — only the last write should be read
      await Bun.write(headPath, 'ref: refs/heads/branch-a\n');
      callback('change', 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/branch-b\n');
      callback('change', 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/branch-c\n');
      callback('change', 'HEAD');

      await new Promise(resolve => setTimeout(resolve, 300));

      // Debounce should mean only one call with the final content
      expect(onBranchChanged).toHaveBeenCalledTimes(1);
      expect(onBranchChanged).toHaveBeenCalledWith('session-1', 'branch-c');

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should stop all watchers on stopAll', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      await Bun.write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(async () => {}, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');
      expect(service.isWatching('session-1')).toBe(true);

      service.stopAll();
      expect(service.isWatching('session-1')).toBe(false);
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should replace existing watcher when startWatching is called again', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      await Bun.write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/branch-a\n');

      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(async () => {}, mockWatch);
      await service.startWatching('session-1', tmpDir, 'branch-a');

      // Start again — should close old watcher and create new one
      await service.startWatching('session-1', tmpDir, 'branch-b');
      expect(service.isWatching('session-1')).toBe(true);

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should not start watcher when HEAD file does not exist', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(async () => {}, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');

      expect(service.isWatching('session-1')).toBe(false);
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('stopWatching should be no-op for unknown session', () => {
    const service = new BranchWatcherService(async () => {});
    service.stopWatching('unknown-session');
    expect(service.isWatching('unknown-session')).toBe(false);
  });

  it('should reconcile stale branch on startWatching', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      // HEAD says 'feature-branch' but caller passes 'stale-branch'
      await Bun.write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature-branch\n');

      const onBranchChanged = mock(async (_sid: string, _branch: string) => {});
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(onBranchChanged, mockWatch);

      await service.startWatching('session-1', tmpDir, 'stale-branch');

      // Should have immediately called onBranchChanged to reconcile
      expect(onBranchChanged).toHaveBeenCalledWith('session-1', 'feature-branch');
      expect(service.isWatching('session-1')).toBe(true);

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should not reconcile when actual HEAD matches stored branch', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      await Bun.write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

      const onBranchChanged = mock(async (_sid: string, _branch: string) => {});
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(onBranchChanged, mockWatch);

      await service.startWatching('session-1', tmpDir, 'main');

      // No reconciliation needed
      expect(onBranchChanged).not.toHaveBeenCalled();

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('should only update currentBranch after successful sync', async () => {
    const tmpDir = await createTempDir('branch-watcher-svc-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      const headPath = path.join(gitDir, 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/main\n');

      // First call succeeds, second call fails
      let callCount = 0;
      const onBranchChanged = mock(async (_sid: string, _branch: string) => {
        callCount++;
        if (callCount === 2) throw new Error('sync failed');
      });
      const mockWatch = createMockWatch();
      const service = new BranchWatcherService(onBranchChanged, mockWatch);
      await service.startWatching('session-1', tmpDir, 'main');

      // First change: succeeds
      await Bun.write(headPath, 'ref: refs/heads/branch-a\n');
      mockWatchCallbacks.get(headPath)?.('change', 'HEAD');
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(onBranchChanged).toHaveBeenCalledWith('session-1', 'branch-a');

      // Second change: fails — currentBranch should NOT advance
      await Bun.write(headPath, 'ref: refs/heads/branch-b\n');
      mockWatchCallbacks.get(headPath)?.('change', 'HEAD');
      await new Promise(resolve => setTimeout(resolve, 300));

      // Third change: should still detect from branch-a (not branch-b)
      await Bun.write(headPath, 'ref: refs/heads/branch-c\n');
      mockWatchCallbacks.get(headPath)?.('change', 'HEAD');
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(onBranchChanged).toHaveBeenCalledWith('session-1', 'branch-c');

      service.stopAll();
    } finally {
      await removeTempDir(tmpDir);
    }
  });
});
