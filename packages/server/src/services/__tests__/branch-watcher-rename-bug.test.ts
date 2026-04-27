/**
 * Reproduction test for Issue #708 — fs.watch becomes stale after git's
 * atomic rename pattern (HEAD.lock → HEAD).
 *
 * Git updates HEAD via:
 *   1. Write HEAD.lock with new content
 *   2. rename(HEAD.lock, HEAD)  ← atomic, replaces inode
 *
 * Watching the HEAD file by path attaches the watcher to the original
 * inode. After the rename, that inode is gone — the watcher fires once
 * (or on some platforms not at all for the next change) and never sees
 * subsequent updates to the new HEAD inode.
 *
 * This test uses real `fs.watch` (no mock) to demonstrate the failure
 * mode. With the directory-watch fix in branch-watcher-service.ts,
 * subsequent renames continue to fire the callback.
 *
 * Note: This test only runs when `node:fs` is NOT mocked by memfs. When run
 * as part of the full server suite, other tests import `mock-fs-helper.ts`
 * which calls `mock.module('node:fs', ...)` — and bun:test's `mock.module`
 * is process-global and unforgettable. The boundary cases (filename
 * filtering, null filename, HEAD.lock ignore) are covered by injected-mock
 * tests in `branch-watcher-service.test.ts`. This file additionally
 * verifies the real fs.watch behavior end-to-end and is intended to be run
 * directly: `bun test packages/server/src/services/__tests__/branch-watcher-rename-bug.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BranchWatcherService } from '../branch-watcher-service.js';

/**
 * Detect whether `node:fs` has been replaced by memfs (via mock.module in
 * mock-fs-helper.ts). memfs operates on an in-memory volume that does not
 * see files written through Bun.write to the real OS tmpdir, so a
 * round-trip write+stat probe disambiguates real fs from memfs.
 */
function isRealFsActive(): boolean {
  const probePath = path.join(
    os.tmpdir(),
    `branch-watcher-fs-probe-${crypto.randomUUID().slice(0, 8)}`,
  );
  try {
    Bun.spawnSync(['sh', '-c', `printf x > ${probePath}`]);
    fs.statSync(probePath);
    Bun.spawnSync(['rm', '-f', probePath]);
    return true;
  } catch {
    Bun.spawnSync(['rm', '-f', probePath]);
    return false;
  }
}

const REAL_FS = isRealFsActive();

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

/**
 * Simulate git's atomic HEAD update: write HEAD.lock, then rename to HEAD.
 * This replaces the HEAD file's inode atomically.
 */
async function atomicGitHeadUpdate(headFilePath: string, content: string): Promise<void> {
  const lockPath = `${headFilePath}.lock`;
  await Bun.write(lockPath, content);
  // Use mv to perform atomic rename (simulates git's behavior)
  await Bun.spawn(['mv', lockPath, headFilePath]).exited;
}

describe('BranchWatcherService — fs.watch rename robustness (Issue #708)', () => {
  if (!REAL_FS) {
    it.skip('SKIPPED: node:fs is mocked by memfs in this process (run this file directly to exercise real fs.watch)', () => {});
    return;
  }

  it('detects branch changes across multiple atomic renames (real fs.watch)', async () => {
    const tmpDir = await createTempDir('branch-watcher-rename-bug-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      const headPath = path.join(gitDir, 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/main\n');

      const observed: string[] = [];
      const onBranchChanged = async (_sid: string, branch: string) => {
        observed.push(branch);
      };

      // Use real fs.watch (no mock parameter)
      const service = new BranchWatcherService(onBranchChanged);
      await service.startWatching('session-1', tmpDir, 'main');

      // First atomic rename — branch change to feature-a
      await atomicGitHeadUpdate(headPath, 'ref: refs/heads/feature-a\n');
      // Wait for fs.watch event + debounce + handler
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Second atomic rename — branch change to feature-b
      await atomicGitHeadUpdate(headPath, 'ref: refs/heads/feature-b\n');
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Third atomic rename — branch change to feature-c
      await atomicGitHeadUpdate(headPath, 'ref: refs/heads/feature-c\n');
      await new Promise((resolve) => setTimeout(resolve, 600));

      service.stopAll();

      // BUG: With file-level fs.watch, only the first rename is observed,
      // because the watcher's inode is detached after the first rename.
      // After the fix (directory-level watch), all three renames fire.
      expect(observed).toContain('feature-a');
      expect(observed).toContain('feature-b');
      expect(observed).toContain('feature-c');
    } finally {
      await removeTempDir(tmpDir);
    }
  });

  it('detects branch change after rename (single rename, real fs.watch)', async () => {
    const tmpDir = await createTempDir('branch-watcher-rename-bug-');
    try {
      const gitDir = path.join(tmpDir, '.git');
      await createDir(gitDir);
      const headPath = path.join(gitDir, 'HEAD');
      await Bun.write(headPath, 'ref: refs/heads/main\n');

      const observed: string[] = [];
      const onBranchChanged = async (_sid: string, branch: string) => {
        observed.push(branch);
      };

      const service = new BranchWatcherService(onBranchChanged);
      await service.startWatching('session-1', tmpDir, 'main');

      // Single atomic rename
      await atomicGitHeadUpdate(headPath, 'ref: refs/heads/feature-x\n');
      await new Promise((resolve) => setTimeout(resolve, 600));

      service.stopAll();
      expect(observed).toContain('feature-x');
    } finally {
      await removeTempDir(tmpDir);
    }
  });
});
