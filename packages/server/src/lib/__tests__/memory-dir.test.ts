/**
 * Real-filesystem tests for the memory layer's directory creation +
 * verification (epic #1636 Phase 2). Uses real temp dirs under
 * `os.tmpdir()`, cleaned in `afterEach` — this module's whole job is
 * verifying real `mkdir`/`lstat` behavior, so a memfs mock would defeat the
 * point (same rationale as `workers-upload-dir-real-fs.test.ts`).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdir, rm, symlink, writeFile, lstat, chmod } from 'fs/promises';
import { isMemfsActive } from '../../__tests__/utils/memfs-detection.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  resolveMemoryDirContract,
  ensureMemoryDir,
  resolveMemoryDirPath,
  prepareMemoryDir,
  MemoryDirVerificationError,
  type MemoryDirContract,
} from '../memory-dir.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import { computeQuickCwdSlug } from '../session-data-path.js';

const IS_ROOT = typeof process.geteuid === 'function' && process.geteuid() === 0;

const tempDirs: string[] = [];

function freshTempDir(label: string): string {
  const dir = join(tmpdir(), `memory-dir-test-${label}-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('resolveMemoryDirContract', () => {
  it('returns the single-user 0700 contract when AUTH_MODE is not multi-user', () => {
    const prev = process.env.AUTH_MODE;
    delete process.env.AUTH_MODE;
    try {
      const contract = resolveMemoryDirContract();
      expect(contract.mode).toBe(0o700);
      expect(contract.expectedGid).toBeNull();
    } finally {
      if (prev !== undefined) process.env.AUTH_MODE = prev;
    }
  });

  it('returns the multi-user 2775 contract when AUTH_MODE=multi-user', () => {
    const prev = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'multi-user';
    try {
      const contract = resolveMemoryDirContract();
      expect(contract.mode).toBe(0o2775);
      expect(contract.expectedGid).toBe(process.getgid!());
    } finally {
      if (prev !== undefined) process.env.AUTH_MODE = prev;
      else delete process.env.AUTH_MODE;
    }
  });
});

describe('ensureMemoryDir — single-user contract', () => {
  it('creates the directory with mode exactly 0o700', async () => {
    const base = freshTempDir('single-create');
    const dir = join(base, 'memory', 'def-1');
    await ensureMemoryDir(dir, { mode: 0o700, expectedGid: null });
    const st = await lstat(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o700);
  });

  it('is idempotent on a second call (still 0700, no throw)', async () => {
    const base = freshTempDir('single-idempotent');
    const dir = join(base, 'memory', 'def-1');
    await ensureMemoryDir(dir, { mode: 0o700, expectedGid: null });
    await ensureMemoryDir(dir, { mode: 0o700, expectedGid: null });
    const st = await lstat(dir);
    expect(st.mode & 0o7777).toBe(0o700);
  });

  it('creates nested parent segments (memory/<def>) under a fresh base', async () => {
    const base = freshTempDir('single-nested');
    const dir = join(base, 'memory', 'def-nested');
    await ensureMemoryDir(dir, { mode: 0o700, expectedGid: null });
    const st = await lstat(dir);
    expect(st.isDirectory()).toBe(true);
  });

  // Removing the symlink check in ensureMemoryDir fails this pin -- measured
  // below. NOTE: the temp-dir label deliberately avoids the substring
  // "symlink" (used "single-link" instead) -- an earlier draft of this test
  // used a label containing "symlink", which made the rejected path itself
  // (embedded in the thrown message) satisfy a `.toMatch(/symlink/)`
  // assertion regardless of which check inside `ensureMemoryDir` actually
  // fired. The assertion below matches the production message's specific
  // "is a symlink" phrase for the same reason.
  it('rejects a pre-created symlink at the path', async () => {
    const base = freshTempDir('single-link');
    const targetDir = join(base, 'target');
    await mkdir(targetDir, { recursive: true });
    const linkPath = join(base, 'memory-link');
    await symlink(targetDir, linkPath);
    let caught: unknown;
    try {
      await ensureMemoryDir(linkPath, { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    expect((caught as Error).message).toMatch(/is a symlink/);
  });

  it('rejects a pre-created regular file at the path', async () => {
    const base = freshTempDir('single-file');
    const filePath = join(base, 'not-a-dir');
    await mkdir(base, { recursive: true });
    await writeFile(filePath, 'hello');
    await expect(ensureMemoryDir(filePath, { mode: 0o700, expectedGid: null })).rejects.toThrow(
      MemoryDirVerificationError,
    );
  });

  // Reach measured: disabling the mode-exactness `if` in ensureMemoryDir
  // (replacing its condition with `false`) fails this pin AND the
  // multi-user 2755-rejection pin below -- both measured.
  it('rejects a pre-created directory whose mode is 0o755 (mode-exactness pin)', async () => {
    const base = freshTempDir('single-wrong-mode');
    const dir = join(base, 'memory', 'def-1');
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    let caught: unknown;
    try {
      await ensureMemoryDir(dir, { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    const message = (caught as Error).message;
    expect(message).toContain('755');
    expect(message).toContain('700');
  });
});

describe('ensureMemoryDir — multi-user contract (real fs, Linux only)', () => {
  it('creates 2775/expected-gid under umask 0002, and rejects 2755 under umask 0022 (mode-exactness pin)', async () => {
    if (process.platform !== 'linux' || typeof process.getgid !== 'function') {
      console.warn('Skipping multi-user setgid test: not Linux or no process.getgid');
      return;
    }
    if (IS_ROOT) {
      console.warn('Skipping multi-user setgid test: running as root (permission checks bypassed)');
      return;
    }
    // In the full server suite `fs/promises` is process-globally swapped for
    // memfs (mock-fs-helper.ts), so `chmod(1)` on a memfs-only directory and
    // the kernel's setgid inheritance cannot be observed. Same discipline as
    // workers-upload-dir-real-fs.test.ts: run this file alone to exercise.
    if (await isMemfsActive()) {
      console.warn('[skip] memfs is active in this process; run this file alone (`bun test memory-dir.test.ts`) to exercise the real setgid inheritance.');
      return;
    }
    const base = freshTempDir('multi-user');
    await mkdir(base, { recursive: true });
    const chmodProc = Bun.spawn(['chmod', '2775', base], { stdout: 'pipe', stderr: 'pipe' });
    const chmodExit = await chmodProc.exited;
    if (chmodExit !== 0) {
      console.warn('Skipping multi-user setgid test: chmod 2775 failed on this filesystem');
      return;
    }
    const parentSt = await lstat(base);
    if ((parentSt.mode & 0o2000) === 0) {
      console.warn('Skipping multi-user setgid test: filesystem did not apply setgid bit');
      return;
    }

    const contract: MemoryDirContract = { mode: 0o2775, expectedGid: process.getgid() };
    const prevUmask = process.umask(0o002);
    try {
      const dir = join(base, 'memory', 'def-1');
      await ensureMemoryDir(dir, contract);
      const st = await lstat(dir);
      expect(st.mode & 0o7777).toBe(0o2775);
      expect(st.gid).toBe(process.getgid());
    } finally {
      process.umask(prevUmask);
    }

    // Negative: under umask 0022, mkdir-with-no-mode-arg inherits 2755
    // (world-r-x stripped of group-write), which must FAIL the exactness
    // check against the 2775 contract.
    const prevUmask2 = process.umask(0o022);
    try {
      const dir2 = join(base, 'memory', 'def-2');
      let caught: unknown;
      try {
        await ensureMemoryDir(dir2, contract);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MemoryDirVerificationError);
      const message = (caught as Error).message;
      expect(message).toContain('2755');
      expect(message).toContain('2775');
    } finally {
      process.umask(prevUmask2);
    }
  });
});

describe('resolveMemoryDirPath', () => {
  it('worktree session -> <base>/memory/<def>', async () => {
    const resolver = new SessionDataPathResolver('/test/config/repositories/myorg/myrepo');
    const dir = await resolveMemoryDirPath({
      session: { type: 'worktree', locationPath: '/test/worktree' },
      definitionId: 'def-1',
      resolver,
    });
    expect(dir).toBe('/test/config/repositories/myorg/myrepo/memory/def-1');
  });

  it('quick session with a real existing cwd -> <base>/memory/<def>/<slug-of-realpath>', async () => {
    const base = freshTempDir('quick-real-cwd');
    await mkdir(base, { recursive: true });
    const resolver = new SessionDataPathResolver('/test/config/_quick');
    const dir = await resolveMemoryDirPath({
      session: { type: 'quick', locationPath: base },
      definitionId: 'def-1',
      resolver,
    });
    const expectedSlug = computeQuickCwdSlug(base);
    expect(dir).toBe(`/test/config/_quick/memory/def-1/${expectedSlug}`);
  });

  // Reach measured: removing the try/catch fallback in resolveMemoryDirPath
  // (calling `realpath` unconditionally) fails this pin with an unhandled
  // ENOENT -- measured.
  it('quick session with a nonexistent cwd falls back to computeQuickCwdSlug(cwd) directly', async () => {
    const resolver = new SessionDataPathResolver('/test/config/_quick');
    const dir = await resolveMemoryDirPath({
      session: { type: 'quick', locationPath: '/test/quick' },
      definitionId: 'def-1',
      resolver,
    });
    const expectedSlug = computeQuickCwdSlug('/test/quick');
    expect(dir).toBe(`/test/config/_quick/memory/def-1/${expectedSlug}`);
  });
});

describe('prepareMemoryDir', () => {
  it('resolves, creates, and returns the memory dir for a worktree session', async () => {
    const base = freshTempDir('prepare-worktree');
    const resolver = new SessionDataPathResolver(base);
    const dir = await prepareMemoryDir({
      session: { type: 'worktree', locationPath: '/test/worktree' } as unknown as never,
      definition: { id: 'def-1' } as unknown as never,
      resolver,
    });
    expect(dir).toBe(join(base, 'memory', 'def-1'));
    const st = await lstat(dir!);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o700);
  });
});
